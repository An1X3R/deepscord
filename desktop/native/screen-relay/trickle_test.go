package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func consumeNativeCandidates(t *testing.T, endpoint string, pc *webrtc.PeerConnection, id string, nonce string) {
	t.Helper()
	after := 0
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Get(fmt.Sprintf("%s/session/%s/ice?after=%d&negotiationId=%s", endpoint, id, after, nonce))
		if err != nil {
			t.Fatal(err)
		}
		var batch candidateResponse
		err = json.NewDecoder(response.Body).Decode(&batch)
		response.Body.Close()
		if err != nil || response.StatusCode != 200 || batch.ID != id || batch.NegotiationID != nonce || batch.After != after || batch.Next != after+len(batch.Candidates) {
			t.Fatalf("invalid native candidate batch: status=%d batch=%+v error=%v", response.StatusCode, batch, err)
		}
		for _, value := range batch.Candidates {
			if err = pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: value.Candidate, SDPMid: value.SDPMid, SDPMLineIndex: value.SDPMLineIndex, UsernameFragment: value.UsernameFragment}); err != nil {
				t.Fatal(err)
			}
		}
		after = batch.Next
		if batch.Complete {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("native candidate polling exceeded ten seconds")
}

func postCandidate(t *testing.T, endpoint string, id string, nonce string, value candidateJSON, expected int) {
	t.Helper()
	body, err := json.Marshal(struct {
		NegotiationID string        `json:"negotiationId"`
		Candidate     candidateJSON `json:"candidate"`
	}{nonce, value})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(endpoint+"/session/"+id+"/ice", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	details, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != expected {
		t.Fatalf("ICE status=%d want=%d body=%s error=%v", response.StatusCode, expected, details, err)
	}
}

func postTrickleOffer(t *testing.T, endpoint string, request offerRequest) answerResponse {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(endpoint+"/session", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		details, readErr := io.ReadAll(response.Body)
		t.Fatalf("trickle offer status=%d body=%s readError=%v", response.StatusCode, details, readErr)
	}
	var answer answerResponse
	if err = json.NewDecoder(response.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if answer.ID != request.ID || answer.NegotiationID != request.NegotiationID || answer.SDP == nil {
		t.Fatalf("trickle answer identity mismatch: %+v", answer)
	}
	return answer
}

func TestRealTrickleBlackholeSTUNRTPAndRevocation(t *testing.T) {
	blackhole, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer blackhole.Close()
	var stunRequests atomic.Uint64
	go func() {
		buffer := make([]byte, 2048)
		for {
			if _, _, readErr := blackhole.ReadFrom(buffer); readErr != nil {
				return
			}
			stunRequests.Add(1)
		}
	}()
	helper, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(helper.routes())
	defer endpoint.Close()
	t.Cleanup(func() {
		helper.mu.RLock()
		peers := make([]*session, 0, len(helper.sessions))
		for _, peer := range helper.sessions {
			peers = append(peers, peer)
		}
		helper.mu.RUnlock()
		for _, peer := range peers {
			helper.remove(peer)
		}
	})
	client, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	pc, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(pc)
	track, err := webrtc.NewTrackLocalStaticRTP(vp8Capability(), "screen", "screen")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pc.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	local := make(chan *webrtc.ICECandidate, candidateLimit)
	pc.OnICECandidate(func(value *webrtc.ICECandidate) { local <- value })
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	// CreateOffer is intentionally candidate-free; local candidates travel only through the HTTP ICE endpoint.
	if strings.Contains(offer.SDP, "a=candidate:") {
		t.Fatal("initial test offer unexpectedly contains candidates")
	}
	request := offerRequest{ID: "trickle-publisher", NegotiationID: "trickle-first", Role: "publish", Source: "trickle-source", SDP: offer, Network: networkRequest{ICEServers: []iceServerRequest{{URLs: []string{"stun:" + blackhole.LocalAddr().String()}}}, Policy: "all"}, Admission: admissionRequest{StreamBps: 500000, SourceBudgetBps: 8000000, Locality: "remote"}}
	started := time.Now()
	answer := postTrickleOffer(t, endpoint.URL, request)
	answerLatency := time.Since(started)
	if answerLatency > 2*time.Second {
		t.Fatal("answer waited for the blackhole STUN gather")
	}
	if err = pc.SetRemoteDescription(*answer.SDP); err != nil {
		t.Fatal(err)
	}
	mid, ufrag, err := remoteICEIdentity(offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	index := uint16(0)
	var first candidateJSON
	for {
		value := <-local
		if value == nil {
			break
		}
		wire := value.ToJSON()
		first = candidateJSON{Candidate: wire.Candidate, SDPMid: &mid, SDPMLineIndex: &index, UsernameFragment: &ufrag}
		postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, first, 200)
	}
	postCandidate(t, endpoint.URL, request.ID, "stale-nonce", first, 409)
	wrong := first
	wrongFragment := "incorrect-ufrag"
	wrong.UsernameFragment = &wrongFragment
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, wrong, 400)
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, candidateJSON{}, 200)
	after := 0
	for pc.ConnectionState() != webrtc.PeerConnectionStateConnected && time.Since(started) < 3*time.Second {
		response, getErr := http.Get(fmt.Sprintf("%s/session/%s/ice?after=%d&negotiationId=%s", endpoint.URL, request.ID, after, request.NegotiationID))
		if getErr != nil {
			t.Fatal(getErr)
		}
		var batch candidateResponse
		decodeErr := json.NewDecoder(response.Body).Decode(&batch)
		response.Body.Close()
		if decodeErr != nil || response.StatusCode != 200 {
			t.Fatalf("candidate poll status=%d error=%v", response.StatusCode, decodeErr)
		}
		for _, value := range batch.Candidates {
			if err = pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: value.Candidate, SDPMid: value.SDPMid, SDPMLineIndex: value.SDPMLineIndex, UsernameFragment: value.UsernameFragment}); err != nil {
				t.Fatal(err)
			}
		}
		after = batch.Next
		time.Sleep(10 * time.Millisecond)
	}
	if pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
		t.Fatal("trickle host path did not connect during the STUN blackhole")
	}
	helper.mu.RLock()
	peer := helper.sessions[request.ID]
	helper.mu.RUnlock()
	if peer.pc.ICEGatheringState() == webrtc.ICEGatheringStateComplete {
		t.Fatal("blackhole gather completed before connection; test did not exercise incremental ICE")
	}
	for sequence := uint16(1); sequence <= 10; sequence++ {
		if err = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000, Marker: true}, Payload: []byte{0x10, 1, 2, 3}}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitUntil(t, "real RTP did not reach helper during gathering", func() bool { return peer.packets.Load() > 0 && stunRequests.Load() > 0 })
	if peer.pc.ICEGatheringState() == webrtc.ICEGatheringStateComplete {
		t.Fatal("RTP arrived only after full gathering")
	}
	t.Logf("candidate-free answer=%s connected/RTP=%s before STUN completion; packets=%d STUN requests=%d", answerLatency, time.Since(started), peer.packets.Load(), stunRequests.Load())
	helper.remove(peer)
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, first, 409)
	response, getErr := http.Get(fmt.Sprintf("%s/session/%s/ice?after=0&negotiationId=%s", endpoint.URL, request.ID, request.NegotiationID))
	if getErr != nil {
		t.Fatal(getErr)
	}
	response.Body.Close()
	if response.StatusCode != 409 {
		t.Fatal("removed session candidates were exposed")
	}
	request.NegotiationID = "trickle-second"
	request.Network = networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}
	postTrickleOffer(t, endpoint.URL, request)
	postCandidate(t, endpoint.URL, request.ID, "trickle-first", first, 409)
	helper.mu.RLock()
	replacement := helper.sessions[request.ID]
	helper.mu.RUnlock()
	if replacement == nil || replacement == peer || replacement.negotiationID != request.NegotiationID || replacement.remoteCandidates != 0 {
		t.Fatal("stale candidate reached a replacement session")
	}
	t.Log("same session ID reused with a fresh negotiationId; late old candidates rejected")
}

func TestRealTricklePreviewCandidateValidationAndLimit(t *testing.T) {
	helper, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(helper.routes())
	defer endpoint.Close()
	client, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	pc, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(pc)
	if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	request := offerRequest{ID: "preview-validation", NegotiationID: "preview-first", Role: "subscribe", Source: "pending-source", SDP: offer, Network: networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}, Admission: admissionRequest{StreamBps: 500000, SourceBudgetBps: 8000000, Locality: "loopback-preview"}}
	postTrickleOffer(t, endpoint.URL, request)
	helper.mu.RLock()
	peer := helper.sessions[request.ID]
	helper.mu.RUnlock()
	defer helper.remove(peer)
	mid, ufrag, err := remoteICEIdentity(offer.SDP)
	if err != nil {
		t.Fatal(err)
	}
	index := uint16(0)
	value := candidateJSON{Candidate: "candidate:1 1 udp 2130706431 203.0.113.9 12345 typ host", SDPMid: &mid, SDPMLineIndex: &index, UsernameFragment: &ufrag}
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, value, 400)
	value.Candidate = "candidate:1 1 udp 2130706431 127.0.0.1 12345 typ relay raddr 127.0.0.1 rport 12345"
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, value, 400)
	value.Candidate = "candidate:1 1 udp 2130706431 invalid.local 12345 typ host"
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, value, 400)
	value.Candidate = "candidate:1 1 udp 2130706431 127.0.0.1 12345 typ host"
	wrongMid := "other-video"
	wrong := value
	wrong.SDPMid = &wrongMid
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, wrong, 400)
	for i := 0; i < candidateLimit; i++ {
		postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, value, 200)
	}
	postCandidate(t, endpoint.URL, request.ID, request.NegotiationID, value, 429)
	t.Log("candidate-free preview accepted; foreign/relay/mDNS/wrong-mid rejected; remote limit=128 enforced")
}
