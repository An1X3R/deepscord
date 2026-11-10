package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
	"golang.org/x/time/rate"
)

type admissionRequest struct {
	StreamBps           int64  `json:"streamBps"`
	SubscriberBudgetBps int64  `json:"subscriberBudgetBps"`
	SourceBudgetBps     int64  `json:"sourceBudgetBps"`
	Locality            string `json:"locality"`
}

func vp8Capability() webrtc.RTPCodecCapability {
	return webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: []webrtc.RTCPFeedback{{Type: "goog-remb"}, {Type: "ccm", Parameter: "fir"}, {Type: "nack"}, {Type: "nack", Parameter: "pli"}}}
}

func registerVP8(engine *webrtc.MediaEngine) error {
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: vp8Capability(), PayloadType: 96}, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	return engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: "video/rtx", ClockRate: 90000, SDPFmtpLine: "apt=96"}, PayloadType: 97}, webrtc.RTPCodecTypeVideo)
}

func validateMediaOffer(request offerRequest) error {
	a := request.Admission
	if a.StreamBps < 128000 || a.StreamBps > 40000000 || a.SourceBudgetBps < 0 || a.SourceBudgetBps > 1000000000 || a.SubscriberBudgetBps < 0 || a.SubscriberBudgetBps > 48000000 {
		return errors.New("explicit admission rates are outside the supported screen range")
	}
	if a.Locality != "remote" && a.Locality != "loopback-preview" {
		return errors.New("admission.locality must be remote or loopback-preview")
	}
	if request.Role == "publish" && (a.Locality != "remote" || a.SubscriberBudgetBps != 0) {
		return errors.New("publish requires remote locality and zero subscriberBudgetBps")
	}
	if request.Role == "subscribe" && a.Locality == "remote" && a.SubscriberBudgetBps < a.StreamBps {
		return errors.New("remote subscription budget must cover streamBps and explicit overhead allowance")
	}
	if a.Locality == "loopback-preview" && (request.Role != "subscribe" || a.SubscriberBudgetBps != 0 || request.Network.Policy != "all" || len(request.Network.ICEServers) != 0) {
		return errors.New("loopback-preview requires subscribe, zero WAN budget and explicit empty/all ICE configuration")
	}
	description := sdp.SessionDescription{}
	if err := description.Unmarshal([]byte(request.SDP.SDP)); err != nil {
		return fmt.Errorf("invalid SDP: %w", err)
	}
	if len(description.MediaDescriptions) != 1 || description.MediaDescriptions[0].MediaName.Media != "video" {
		return errors.New("exactly one video media section is required")
	}
	media := description.MediaDescriptions[0]
	direction := "recvonly"
	if request.Role == "publish" {
		direction = "sendonly"
	}
	foundDirection, foundVP8, candidates := false, false, 0
	for _, attr := range media.Attributes {
		if attr.Key == direction {
			foundDirection = true
		}
		if attr.Key == "rtpmap" && strings.Contains(strings.ToLower(attr.Value), "vp8/90000") {
			foundVP8 = true
		}
		if attr.Key == "simulcast" || attr.Key == "rid" {
			return errors.New("simulcast is not supported by the one-hop screen relay")
		}
		if attr.Key == "candidate" {
			candidates++
			if candidates > candidateLimit {
				return errors.New("initial remote ICE candidate limit of 128 exceeded")
			}
			if a.Locality == "loopback-preview" {
				candidate, err := ice.UnmarshalCandidate(attr.Value)
				if err != nil {
					return fmt.Errorf("invalid preview candidate: %w", err)
				}
				if candidate.Type() != ice.CandidateTypeHost || !localAddress(candidate.Address()) {
					return errors.New("preview candidates must be literal addresses of this computer; disable WebRtcHideLocalIpsWithMdns for the desktop app")
				}
			}
		}
	}
	if !foundDirection || !foundVP8 {
		return errors.New("offer requires explicit role direction and VP8")
	}
	return nil
}

func localAddress(address string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, address := range addresses {
		network, ok := address.(*net.IPNet)
		if ok && network.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// Offers cannot change the helper budget; only the explicit budget endpoint can.
func (s *server) admitLocked(request offerRequest) error {
	if len(s.sessions) >= 24 {
		return errors.New("helper session limit 24 reached")
	}
	sources := make(map[string]struct{})
	subscribers := 0
	total := request.Admission.SubscriberBudgetBps
	for _, peer := range s.sessions {
		sources[peer.source] = struct{}{}
		total += peer.admission.SubscriberBudgetBps
		if peer.source == request.Source {
			if peer.admission.StreamBps != request.Admission.StreamBps {
				return errors.New("source streamBps is immutable while its sessions exist")
			}
			if peer.role == "subscribe" {
				subscribers++
			}
		}
	}
	if _, exists := sources[request.Source]; !exists && len(sources) >= 4 {
		return errors.New("helper source limit 4 reached")
	}
	if request.Role == "subscribe" && subscribers >= 8 {
		return errors.New("source subscriber limit 8 reached")
	}
	if s.budgetSet && s.budgetBps != request.Admission.SourceBudgetBps {
		return errors.New("offer sourceBudgetBps differs from the explicit helper budget; call the budget endpoint first")
	}
	if total > request.Admission.SourceBudgetBps {
		return fmt.Errorf("aggregate egress admission exceeds helper budget: requested=%d limit=%d", total, request.Admission.SourceBudgetBps)
	}
	s.budgetBps = request.Admission.SourceBudgetBps
	s.budgetSet = true
	return nil
}

type queuedPacket struct {
	packet *rtp.Packet
	queued time.Time
	bytes  int64
}
type egressLimiter struct {
	limiter   *rate.Limiter
	ctx       context.Context
	once      sync.Once
	onFailure func()
}

func newEgressLimiter(peer *session, onFailure func()) *egressLimiter {
	bps := peer.admission.SubscriberBudgetBps
	if peer.admission.Locality == "loopback-preview" || peer.role == "publish" {
		bps = 48000000
	}
	return &egressLimiter{limiter: rate.NewLimiter(rate.Limit(float64(bps)/8), 64<<10), ctx: peer.ctx, onFailure: onFailure}
}

// All local RTP writes, including interceptor RTX, pass through this limiter.
func (limiter *egressLimiter) wait(size int) error {
	ctx, cancel := context.WithTimeout(limiter.ctx, 500*time.Millisecond)
	defer cancel()
	if err := limiter.limiter.WaitN(ctx, size); err != nil {
		if limiter.ctx.Err() == nil {
			limiter.once.Do(limiter.onFailure)
		}
		return fmt.Errorf("bounded RTP egress reservation failed: bytes=%d: %w", size, err)
	}
	return nil
}

func (s *server) failSession(peer *session, diagnostic string) {
	peer.failure.Do(func() {
		s.mu.Lock()
		if s.sessions[peer.id] != peer {
			s.mu.Unlock()
			return
		}
		if peer.diagnostic == "" {
			peer.diagnostic = diagnostic
		}
		s.mu.Unlock()
		slog.Warn("session_overload_or_expiry", "id", peer.id, "source", peer.source, "diagnostic", diagnostic)
		s.remove(peer)
	})
}

func (s *server) enqueue(peer *session, packet *rtp.Packet) {
	size := int64(packet.MarshalSize())
	if peer.queueBytes.Add(size) > 512<<10 {
		peer.queueBytes.Add(-size)
		go s.failSession(peer, "egress_queue_bytes_exceeded")
		return
	}
	select {
	case <-peer.ctx.Done():
		peer.queueBytes.Add(-size)
	case peer.queue <- queuedPacket{packet: packet, queued: time.Now(), bytes: size}:
	default:
		peer.queueBytes.Add(-size)
		go s.failSession(peer, "egress_queue_overflow")
	}
}

func (s *server) sendQueued(peer *session) {
	for {
		select {
		case <-peer.ctx.Done():
			return
		case queued := <-peer.queue:
			peer.queueBytes.Add(-queued.bytes)
			if time.Since(queued.queued) > 500*time.Millisecond {
				s.failSession(peer, "egress_queue_age_exceeded")
				return
			}
			if err := peer.track.WriteRTP(queued.packet); err != nil {
				if peer.ctx.Err() == nil {
					slog.Warn("rtp_forward_failed", "id", peer.id, "error", err)
					s.failSession(peer, "rtp_write_failed")
				}
				return
			}
			peer.bytes.Add(uint64(queued.bytes))
			peer.packets.Add(1)
			peer.lastPacket.Store(time.Now().UnixNano())
			if queued.packet.Extension {
				peer.colorPackets.Add(1)
			}
		}
	}
}

func (s *server) expireInactive(peer *session) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-peer.ctx.Done():
			return
		case now := <-ticker.C:
			last := peer.lastPacket.Load()
			if last == 0 && now.Sub(peer.created) > 25*time.Second {
				s.failSession(peer, "first_rtp_timeout")
				return
			}
		}
	}
}
