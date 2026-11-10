package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

type offerRequest struct {
	ID            string                    `json:"id"`
	NegotiationID string                    `json:"negotiationId"`
	Role          string                    `json:"role"`
	Source        string                    `json:"source"`
	SDP           webrtc.SessionDescription `json:"sdp"`
	Network       networkRequest            `json:"network"`
	Admission     admissionRequest          `json:"admission"`
}

type iceServerRequest struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

type networkRequest struct {
	ICEServers []iceServerRequest `json:"iceServers"`
	Policy     string             `json:"policy"`
}

func configuration(request networkRequest) (webrtc.Configuration, error) {
	if request.ICEServers == nil || len(request.ICEServers) > 32 {
		return webrtc.Configuration{}, errors.New("network.iceServers must be an explicit array with at most 32 entries; use [] for no external ICE")
	}
	var policy webrtc.ICETransportPolicy
	switch request.Policy {
	case "all":
		policy = webrtc.ICETransportPolicyAll
	case "relay":
		policy = webrtc.ICETransportPolicyRelay
	default:
		return webrtc.Configuration{}, errors.New("network.policy must explicitly be all or relay")
	}
	servers := make([]webrtc.ICEServer, 0, len(request.ICEServers))
	turnCount := 0
	for index, server := range request.ICEServers {
		if len(server.URLs) == 0 || len(server.URLs) > 8 {
			return webrtc.Configuration{}, fmt.Errorf("network.iceServers[%d].urls must contain 1-8 STUN/TURN URLs", index)
		}
		for urlIndex, raw := range server.URLs {
			parsed, err := stun.ParseURI(raw)
			if err != nil {
				return webrtc.Configuration{}, fmt.Errorf("invalid network.iceServers[%d].urls[%d]: %w", index, urlIndex, err)
			}
			if parsed.Scheme == stun.SchemeTypeTURN || parsed.Scheme == stun.SchemeTypeTURNS {
				if server.Username == "" || server.Credential == "" {
					return webrtc.Configuration{}, fmt.Errorf("network.iceServers[%d] TURN requires nonempty username and credential", index)
				}
				turnCount++
			}
		}
		servers = append(servers, webrtc.ICEServer{URLs: append([]string{}, server.URLs...), Username: server.Username, Credential: server.Credential, CredentialType: webrtc.ICECredentialTypePassword})
	}
	if policy == webrtc.ICETransportPolicyRelay && turnCount == 0 {
		return webrtc.Configuration{}, errors.New("network.policy relay requires at least one TURN URL with credentials")
	}
	return webrtc.Configuration{ICEServers: servers, ICETransportPolicy: policy}, nil
}

type answerResponse struct {
	ID            string                     `json:"id"`
	NegotiationID string                     `json:"negotiationId"`
	SDP           *webrtc.SessionDescription `json:"sdp"`
}

type session struct {
	id               string
	negotiationID    string
	iceMu            sync.Mutex
	localCandidates  []candidateJSON
	localComplete    bool
	remoteComplete   bool
	remoteCandidates int
	remoteReady      bool
	remoteMid        string
	remoteUfrag      string
	role             string
	source           string
	pc               *webrtc.PeerConnection
	track            *webrtc.TrackLocalStaticRTP
	remote           *webrtc.TrackRemote
	bytes            atomic.Uint64
	packets          atomic.Uint64
	pli              atomic.Uint64
	nack             atomic.Uint64
	fir              atomic.Uint64
	lastPLI          atomic.Int64
	created          time.Time
	wire             wireCounts
	policy           string
	sender           *webrtc.RTPSender
	colorID          atomic.Uint32
	colorPackets     atomic.Uint64
	admission        admissionRequest
	lastPacket       atomic.Int64
	queue            chan queuedPacket
	queueBytes       atomic.Int64
	ctx              context.Context
	cancel           context.CancelFunc
	limiter          *egressLimiter
	diagnostic       string
	failure          sync.Once
}

type wireCounts struct {
	sent        atomic.Uint64
	received    atomic.Uint64
	packetsSent atomic.Uint64
	repair      *repairState
	egress      *egressLimiter
	locality    string
}

type meterFactory struct{ counts *wireCounts }
type meterInterceptor struct {
	interceptor.NoOp
	counts *wireCounts
}

func (factory *meterFactory) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	return &meterInterceptor{counts: factory.counts}, nil
}

func (meter *meterInterceptor) BindLocalStream(_ *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if meter.counts.egress != nil {
			if err := meter.counts.egress.wait(header.MarshalSize() + len(payload)); err != nil {
				return 0, err
			}
		}
		n, err := writer.Write(header, payload, attributes)
		if err == nil {
			meter.counts.sent.Add(uint64(header.MarshalSize() + len(payload)))
			meter.counts.packetsSent.Add(1)
		}
		return n, err
	})
}

func (meter *meterInterceptor) BindRemoteStream(_ *interceptor.StreamInfo, reader interceptor.RTPReader) interceptor.RTPReader {
	return interceptor.RTPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		n, attributes, err := reader.Read(buffer, attributes)
		if err == nil {
			meter.counts.received.Add(uint64(n))
		}
		return n, attributes, err
	})
}

type sessionStats struct {
	ID                         string             `json:"id"`
	Role                       string             `json:"role"`
	Source                     string             `json:"source"`
	State                      string             `json:"state"`
	TrackReady                 bool               `json:"trackReady"`
	Codec                      string             `json:"codec"`
	RTPBytes                   uint64             `json:"rtpBytes"`
	RTPPackets                 uint64             `json:"rtpPackets"`
	PLI                        uint64             `json:"pli"`
	NACK                       uint64             `json:"nack"`
	FIR                        uint64             `json:"fir"`
	TransportBytesSent         uint64             `json:"transportBytesSent"`
	TransportBytesReceived     uint64             `json:"transportBytesReceived"`
	WireRTPBytesSent           uint64             `json:"wireRtpBytesSent"`
	WireRTPBytesReceived       uint64             `json:"wireRtpBytesReceived"`
	WireRTPPacketsSent         uint64             `json:"wireRtpPacketsSent"`
	Created                    time.Time          `json:"created"`
	NetworkPolicy              string             `json:"networkPolicy"`
	SelectedCandidatePair      *selectedPairStats `json:"selectedCandidatePair"`
	ColorSpaceExtensionID      uint32             `json:"colorSpaceExtensionId"`
	ColorSpacePackets          uint64             `json:"colorSpacePackets"`
	RepairedPackets            uint64             `json:"repairedPackets"`
	DuplicatePackets           uint64             `json:"duplicatePackets"`
	OutsideRepairWindowPackets uint64             `json:"outsideRepairWindowPackets"`
	FilteredRepairNacks        uint64             `json:"filteredRepairNacks"`
	FilteredNackPackets        uint64             `json:"filteredNackPackets"`
	LastPacketAt               *time.Time         `json:"lastPacketAt"`
	Admission                  admissionRequest   `json:"admission"`
	Diagnostic                 string             `json:"diagnostic"`
	QueueBytes                 int64              `json:"queueBytes"`
}

type selectedPairStats struct {
	ID                  string `json:"id"`
	State               string `json:"state"`
	LocalCandidateType  string `json:"localCandidateType"`
	RemoteCandidateType string `json:"remoteCandidateType"`
	LocalProtocol       string `json:"localProtocol"`
	RemoteProtocol      string `json:"remoteProtocol"`
	LocalAddress        string `json:"localAddress"`
	LocalPort           int32  `json:"localPort"`
	RemoteAddress       string `json:"remoteAddress"`
	RemotePort          int32  `json:"remotePort"`
}

type cpuMeasurement struct {
	seconds *float64
	status  string
}

type serverStats struct {
	SourceBudgetBps int64          `json:"sourceBudgetBps"`
	AdmittedBps     int64          `json:"admittedBps"`
	PID             int            `json:"pid"`
	Started         time.Time      `json:"started"`
	Now             time.Time      `json:"now"`
	HeapBytes       uint64         `json:"heapBytes"`
	AllocatedBytes  uint64         `json:"allocatedBytes"`
	Goroutines      int            `json:"goroutines"`
	Sessions        []sessionStats `json:"sessions"`
	CPUTimeSeconds  *float64       `json:"cpuTimeSeconds"`
	CPUTimeStatus   string         `json:"cpuTimeStatus"`
}

type server struct {
	mu        sync.RWMutex
	sessions  map[string]*session
	archive   []sessionStats
	api       *webrtc.API
	started   time.Time
	token     string
	budgetBps int64
	budgetSet bool
}

func newServer() (*server, error) {
	api, err := newAPI(&wireCounts{})
	if err != nil {
		return nil, err
	}
	return &server{sessions: make(map[string]*session), archive: make([]sessionStats, 0), api: api, started: time.Now().UTC()}, nil
}

func newAPI(counts *wireCounts) (*webrtc.API, error) {
	engine := &webrtc.MediaEngine{}
	if err := registerVP8(engine); err != nil {
		return nil, err
	}
	registry := &interceptor.Registry{}
	ledger, err := newReceivedLedger(4096, 1)
	if err != nil {
		return nil, err
	}
	counts.repair = &repairState{ledger: ledger}
	registry.Add(&repairFactory{state: counts.repair})
	if err := engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: colorSpaceURI}, webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverDirectionRecvonly, webrtc.RTPTransceiverDirectionSendonly); err != nil {
		return nil, err
	}
	registry.Add(&meterFactory{counts: counts})
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		return nil, err
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	settings.SetICETimeouts(5*time.Second, 10*time.Second, time.Second)
	if counts.locality == "loopback-preview" {
		settings.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	return api, nil
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.HandleFunc("POST /session", s.offer)
	mux.HandleFunc("POST /session/{id}/ice", s.addCandidate)
	mux.HandleFunc("GET /session/{id}/ice", s.candidates)
	mux.HandleFunc("DELETE /session/{id}", s.disconnect)
	mux.HandleFunc("GET /stats", s.stats)
	mux.HandleFunc("POST /budget", s.updateBudget)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Header.Get("Origin") != "" || (s.token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.token)) != 1) {
			fail(w, http.StatusUnauthorized, errors.New("local helper authentication required"))
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON[T interface {
	map[string]string | answerResponse | serverStats | budgetResponse | candidateResponse
}](w http.ResponseWriter, status int, value T) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Warn("response_write_failed", "error", err)
	}
}

func fail(w http.ResponseWriter, status int, err error) {
	slog.Warn("request_failed", "status", status, "error", err)
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func (s *server) offer(w http.ResponseWriter, r *http.Request) {
	var request offerRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		fail(w, 400, fmt.Errorf("invalid session JSON: %w", err))
		return
	}
	var extra offerRequest
	if err := decoder.Decode(&extra); err != io.EOF {
		fail(w, 400, errors.New("request must contain exactly one JSON object"))
		return
	}
	validID := regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
	if !validID.MatchString(request.ID) || !validID.MatchString(request.Source) || !negotiationIDPattern.MatchString(request.NegotiationID) || (request.Role != "publish" && request.Role != "subscribe") || request.SDP.Type != webrtc.SDPTypeOffer || request.SDP.SDP == "" || len(request.SDP.SDP) > 128<<10 {
		fail(w, 400, errors.New("id/source require 1-128 safe characters; role must be publish/subscribe; SDP must be a bounded nonempty offer"))
		return
	}
	if err := validateMediaOffer(request); err != nil {
		fail(w, 400, err)
		return
	}
	config, err := configuration(request.Network)
	if err != nil {
		fail(w, 400, err)
		return
	}
	mid, ufrag, err := remoteICEIdentity(request.SDP.SDP)
	if err != nil {
		fail(w, 400, err)
		return
	}
	initialCandidates := strings.Count(request.SDP.SDP, "\na=candidate:")
	initialComplete := strings.Contains(request.SDP.SDP, "\na=end-of-candidates")
	if initialComplete {
		initialCandidates++
	}
	if initialCandidates > candidateLimit {
		fail(w, 400, errors.New("initial remote ICE candidate limit of 128 exceeded"))
		return
	}
	current := &session{id: request.ID, negotiationID: request.NegotiationID, remoteMid: mid, remoteUfrag: ufrag, remoteCandidates: initialCandidates, remoteComplete: initialComplete, localCandidates: make([]candidateJSON, 0, candidateLimit), role: request.Role, source: request.Source, created: time.Now().UTC(), policy: request.Network.Policy, admission: request.Admission, queue: make(chan queuedPacket, 256)}
	current.ctx, current.cancel = context.WithCancel(context.Background())
	current.limiter = newEgressLimiter(current, func() { go s.failSession(current, "egress_budget_exceeded") })
	current.wire.egress = current.limiter
	current.wire.locality = request.Admission.Locality
	api, err := newAPI(&current.wire)
	if err != nil {
		fail(w, 500, err)
		return
	}
	pc, err := api.NewPeerConnection(config)
	if err != nil {
		fail(w, 500, err)
		return
	}
	current.pc = pc
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) { s.recordCandidate(current, candidate) })
	s.mu.Lock()
	if err := s.admitLocked(request); err != nil {
		s.mu.Unlock()
		current.cancel()
		closePC(pc)
		fail(w, 409, err)
		return
	}
	if _, exists := s.sessions[current.id]; exists {
		s.mu.Unlock()
		closePC(pc)
		fail(w, 409, fmt.Errorf("session %s already exists; DELETE it before reconnecting", current.id))
		return
	}
	var publisher *session
	for _, candidate := range s.sessions {
		if candidate.role == "publish" && candidate.source == current.source {
			publisher = candidate
			break
		}
	}
	if current.role == "publish" && publisher != nil {
		s.mu.Unlock()
		closePC(pc)
		fail(w, 409, fmt.Errorf("source %s already has publisher %s", current.source, publisher.id))
		return
	}
	if current.role == "subscribe" {
		current.track, err = webrtc.NewTrackLocalStaticRTP(vp8Capability(), "screen", current.source)
		if err != nil {
			s.mu.Unlock()
			closePC(pc)
			fail(w, 500, err)
			return
		}
	}
	s.sessions[current.id] = current
	s.mu.Unlock()
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Info("peer_state", "id", current.id, "role", current.role, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed {
			go s.remove(current)
		}
		if state == webrtc.PeerConnectionStateConnected && current.role == "subscribe" {
			s.requestPLI(current.source)
		}
	})
	if current.role == "publish" {
		pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) { s.receive(current, track, receiver) })
	} else {
		sender, addErr := pc.AddTrack(current.track)
		if addErr != nil {
			s.remove(current)
			fail(w, 500, addErr)
			return
		}
		current.sender = sender
		go s.feedback(current, sender)
		go s.sendQueued(current)
	}
	go s.expireInactive(current)
	if err = pc.SetRemoteDescription(request.SDP); err != nil {
		s.remove(current)
		fail(w, 400, fmt.Errorf("session %s remote offer: %w", current.id, err))
		return
	}
	current.iceMu.Lock()
	current.remoteReady = true
	current.iceMu.Unlock()
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		s.remove(current)
		fail(w, 500, err)
		return
	}
	if err = pc.SetLocalDescription(answer); err != nil {
		s.remove(current)
		fail(w, 500, err)
		return
	}
	if current.sender != nil {
		id, idErr := colorExtensionID(current.sender.GetParameters().HeaderExtensions)
		if idErr != nil {
			s.remove(current)
			fail(w, 500, idErr)
			return
		}
		current.colorID.Store(uint32(id))
		slog.Info("color_space_negotiated", "id", current.id, "role", current.role, "extension_id", id)
	}
	if r.Context().Err() != nil {
		s.remove(current)
		return
	}
	writeJSON(w, 200, answerResponse{ID: current.id, NegotiationID: current.negotiationID, SDP: pc.LocalDescription()})
}

func closePC(pc *webrtc.PeerConnection) {
	if err := pc.Close(); err != nil {
		slog.Warn("peer_close_failed", "error", err)
	}
}

func (s *server) receive(publisher *session, track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	if track.Kind() != webrtc.RTPCodecTypeVideo || track.Codec().MimeType != webrtc.MimeTypeVP8 {
		slog.Error("unexpected_audio_track", "id", publisher.id)
		s.remove(publisher)
		return
	}
	colorID, err := colorExtensionID(receiver.GetParameters().HeaderExtensions)
	if err != nil {
		slog.Error("color_space_id_invalid", "id", publisher.id, "error", err)
		s.remove(publisher)
		return
	}
	publisher.colorID.Store(uint32(colorID))
	slog.Info("color_space_negotiated", "id", publisher.id, "role", publisher.role, "extension_id", colorID)
	s.mu.Lock()
	if publisher.remote != nil {
		s.mu.Unlock()
		slog.Error("multiple_tracks_rejected", "id", publisher.id)
		s.remove(publisher)
		return
	}
	if s.sessions[publisher.id] != publisher {
		s.mu.Unlock()
		return
	}
	publisher.remote = track
	s.mu.Unlock()
	slog.Info("source_ready", "id", publisher.id, "source", publisher.source, "codec", track.Codec().MimeType)
	for {
		packet, attributes, err := track.ReadRTP()
		if err != nil {
			slog.Info("source_stopped", "id", publisher.id, "error", err)
			s.remove(publisher)
			return
		}
		publisher.bytes.Add(uint64(packet.MarshalSize()))
		publisher.packets.Add(1)
		publisher.lastPacket.Store(time.Now().UnixNano())
		if attributes.Get(webrtc.AttributeRtxSsrc) != nil {
			publisher.wire.repair.repairedPackets.Add(1)
		}
		observed, observeErr := publisher.wire.repair.ledger.observe(packet.SSRC, packet.SequenceNumber)
		if observeErr != nil {
			slog.Error("repair_ledger_failed", "id", publisher.id, "ssrc", packet.SSRC, "sequence", packet.SequenceNumber, "error", observeErr)
			s.remove(publisher)
			return
		}
		if observed == duplicateArrival {
			publisher.wire.repair.duplicatePackets.Add(1)
			continue
		}
		if observed == outsideWindowArrival {
			publisher.wire.repair.outsideWindowPackets.Add(1)
		}
		color := packet.GetExtension(colorID)
		if colorID != 0 && len(color) > 0 {
			if !packet.Marker {
				slog.Error("color_space_packet_not_frame_end", "id", publisher.id, "sequence", packet.SequenceNumber)
				s.remove(publisher)
				return
			}
			if publisher.colorPackets.Add(1) == 1 {
				slog.Info("color_space_first_payload", "id", publisher.id, "payload", fmt.Sprintf("%x", color))
			}
		}
		s.mu.RLock()
		consumers := make([]*session, 0)
		for _, peer := range s.sessions {
			if peer.role == "subscribe" && peer.source == publisher.source && peer.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
				consumers = append(consumers, peer)
			}
		}
		s.mu.RUnlock()
		for _, peer := range consumers {
			forwarded, mapErr := forwardColorSpace(packet, colorID, uint8(peer.colorID.Load()))
			if mapErr != nil {
				slog.Error("color_space_forward_failed", "id", peer.id, "error", mapErr)
				go s.remove(peer)
				continue
			}
			s.enqueue(peer, forwarded)
		}
	}
}

func (s *server) feedback(peer *session, sender *webrtc.RTPSender) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			if peer.pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
				slog.Warn("rtcp_read_ended", "id", peer.id, "error", err)
			}
			return
		}
		for _, packet := range packets {
			switch packet.(type) {
			case *rtcp.PictureLossIndication:
				peer.pli.Add(1)
				s.requestPLI(peer.source)
			case *rtcp.FullIntraRequest:
				peer.fir.Add(1)
				s.requestPLI(peer.source)
			case *rtcp.TransportLayerNack:
				peer.nack.Add(1)
			}
		}
	}
}

func (s *server) requestPLI(source string) {
	s.mu.RLock()
	var publisher *session
	var ssrc uint32
	for _, candidate := range s.sessions {
		if candidate.role == "publish" && candidate.source == source && candidate.remote != nil {
			publisher = candidate
			ssrc = uint32(candidate.remote.SSRC())
			break
		}
	}
	s.mu.RUnlock()
	if publisher == nil {
		return
	}
	now := time.Now().UnixNano()
	previous := publisher.lastPLI.Load()
	if now-previous < int64(200*time.Millisecond) || !publisher.lastPLI.CompareAndSwap(previous, now) {
		return
	}
	if err := publisher.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}); err != nil {
		slog.Warn("upstream_pli_failed", "source", source, "error", err)
		return
	}
	publisher.pli.Add(1)
}

func snapshot(peer *session) sessionStats {
	result := sessionStats{ID: peer.id, Role: peer.role, Source: peer.source, State: peer.pc.ConnectionState().String(), TrackReady: peer.remote != nil || peer.track != nil, RTPBytes: peer.bytes.Load(), RTPPackets: peer.packets.Load(), PLI: peer.pli.Load(), NACK: peer.nack.Load(), FIR: peer.fir.Load(), Created: peer.created}
	if peer.remote != nil {
		result.Codec = peer.remote.Codec().MimeType
	}
	if peer.track != nil {
		result.Codec = peer.track.Codec().MimeType
	}
	result.WireRTPBytesSent = peer.wire.sent.Load()
	result.NetworkPolicy = peer.policy
	result.ColorSpaceExtensionID = peer.colorID.Load()
	result.ColorSpacePackets = peer.colorPackets.Load()
	result.WireRTPBytesReceived = peer.wire.received.Load()
	result.WireRTPPacketsSent = peer.wire.packetsSent.Load()
	result.RepairedPackets = peer.wire.repair.repairedPackets.Load()
	result.DuplicatePackets = peer.wire.repair.duplicatePackets.Load()
	result.OutsideRepairWindowPackets = peer.wire.repair.outsideWindowPackets.Load()
	result.FilteredRepairNacks = peer.wire.repair.filteredRepairNacks.Load()
	result.FilteredNackPackets = peer.wire.repair.filteredNackPackets.Load()
	result.Admission = peer.admission
	result.Diagnostic = peer.diagnostic
	result.QueueBytes = peer.queueBytes.Load()
	if last := peer.lastPacket.Load(); last != 0 {
		value := time.Unix(0, last).UTC()
		result.LastPacketAt = &value
	}
	report := peer.pc.GetStats()
	for _, stat := range report {
		switch value := stat.(type) {
		case webrtc.TransportStats:
			result.TransportBytesSent += value.BytesSent
			result.TransportBytesReceived += value.BytesReceived
		case webrtc.ICECandidatePairStats:
			if !value.Nominated || value.State != webrtc.StatsICECandidatePairStateSucceeded {
				continue
			}
			local, localOK := report[value.LocalCandidateID].(webrtc.ICECandidateStats)
			remote, remoteOK := report[value.RemoteCandidateID].(webrtc.ICECandidateStats)
			if localOK && remoteOK {
				result.SelectedCandidatePair = &selectedPairStats{ID: value.ID, State: string(value.State), LocalCandidateType: local.CandidateType.String(), RemoteCandidateType: remote.CandidateType.String(), LocalProtocol: local.Protocol, RemoteProtocol: remote.Protocol, LocalAddress: local.IP, LocalPort: local.Port, RemoteAddress: remote.IP, RemotePort: remote.Port}
			}
		}
	}
	return result
}

func (s *server) remove(target *session) {
	s.mu.Lock()
	if s.sessions[target.id] != target {
		s.mu.Unlock()
		return
	}
	removed := []*session{target}
	delete(s.sessions, target.id)
	if target.role == "publish" {
		for id, peer := range s.sessions {
			if peer.source == target.source {
				removed = append(removed, peer)
				delete(s.sessions, id)
			}
		}
	}
	for _, peer := range removed {
		peer.cancel()
		record := snapshot(peer)
		record.State = "closed"
		s.archive = append(s.archive, record)
		if len(s.archive) > 16 {
			copy(s.archive, s.archive[len(s.archive)-16:])
			s.archive = s.archive[:16]
		}
	}
	s.mu.Unlock()
	for _, peer := range removed {
		closePC(peer.pc)
	}
}

func (s *server) disconnect(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	peer := s.sessions[r.PathValue("id")]
	s.mu.RUnlock()
	if peer == nil {
		writeJSON(w, 200, map[string]string{"id": r.PathValue("id"), "state": "closed"})
		return
	}
	s.remove(peer)
	writeJSON(w, 200, map[string]string{"id": peer.id, "state": "closed"})
}

func (s *server) stats(w http.ResponseWriter, r *http.Request) {
	cpu, err := processCPU()
	if err != nil {
		fail(w, 500, fmt.Errorf("process CPU time sampling failed for PID %d: %w", os.Getpid(), err))
		return
	}
	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	result := serverStats{PID: os.Getpid(), Started: s.started, Now: time.Now().UTC(), HeapBytes: memory.HeapAlloc, AllocatedBytes: memory.TotalAlloc, Goroutines: runtime.NumGoroutine(), Sessions: make([]sessionStats, 0)}
	result.CPUTimeSeconds = cpu.seconds
	result.CPUTimeStatus = cpu.status
	s.mu.RLock()
	result.SourceBudgetBps = s.budgetBps
	result.AdmittedBps = s.admittedLocked()
	result.Sessions = append(result.Sessions, s.archive...)
	for _, peer := range s.sessions {
		result.Sessions = append(result.Sessions, snapshot(peer))
	}
	s.mu.RUnlock()
	writeJSON(w, 200, result)
}

func main() {
	address := flag.String("listen", "", "Required loopback HTTP signaling address, normally 127.0.0.1:0")
	flag.Parse()
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	host, _, err := net.SplitHostPort(*address)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		slog.Error("listen_must_be_loopback", "listen", *address)
		os.Exit(1)
	}
	lab, err := newServer()
	if err != nil {
		slog.Error("sfu_init_failed", "error", err)
		os.Exit(1)
	}
	lab.token = os.Getenv("SCREEN_RELAY_TOKEN")
	if len(lab.token) != 64 {
		slog.Error("missing_child_token")
		os.Exit(1)
	}
	if err := os.Unsetenv("SCREEN_RELAY_TOKEN"); err != nil {
		slog.Error("token_environment_cleanup_failed", "error", err)
		os.Exit(1)
	}
	listener, err := net.Listen("tcp4", *address)
	if err != nil {
		slog.Error("listen_failed", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	go func() {
		_, err := io.Copy(io.Discard, os.Stdin)
		if err != nil {
			slog.Warn("parent_pipe_failed", "error", err)
		}
		stop()
	}()
	httpServer := &http.Server{Addr: *address, Handler: lab.routes(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("shutdown_failed", "error", err)
		}
	}()
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Event string `json:"event"`
		PID   int    `json:"pid"`
		Port  int    `json:"port"`
	}{"ready", os.Getpid(), listener.Addr().(*net.TCPAddr).Port}); err != nil {
		slog.Error("ready_write_failed", "error", err)
		os.Exit(1)
	}
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("http_failed", "error", err)
		os.Exit(1)
	}
	lab.mu.RLock()
	peers := make([]*session, 0, len(lab.sessions))
	for _, peer := range lab.sessions {
		peers = append(peers, peer)
	}
	lab.mu.RUnlock()
	for _, peer := range peers {
		lab.remove(peer)
	}
}
