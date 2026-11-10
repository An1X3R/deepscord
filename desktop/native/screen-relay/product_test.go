package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestBearerAuthenticationRejectsBrowserOrigin(t *testing.T) {
	helper, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	helper.token = strings.Repeat("a", 64)
	endpoint := httptest.NewServer(helper.routes())
	defer endpoint.Close()
	for _, input := range []struct {
		token  string
		origin string
		status int
	}{{"", "", 401}, {helper.token, "https://untrusted.invalid", 401}, {helper.token, "", 200}} {
		request, err := http.NewRequest(http.MethodGet, endpoint.URL+"/health", nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+input.token)
		request.Header.Set("Origin", input.origin)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != input.status {
			t.Fatalf("authentication got %d want %d", response.StatusCode, input.status)
		}
	}
}

func TestRealPreviewNegotiatesBeforePublisherRTP(t *testing.T) {
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
	viewer, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(viewer)
	if _, err = viewer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	var received atomic.Uint64
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			if bytes.Equal(packet.Payload, []byte{0x10, 1, 2, 3}) {
				received.Add(1)
			}
		}
	})
	negotiateAdmitted(t, endpoint.URL, viewer, "preview", "subscribe", admissionRequest{StreamBps: 40000000, SourceBudgetBps: 96000000, SubscriberBudgetBps: 0, Locality: "loopback-preview"})
	waitUntil(t, "preview did not connect without a source", func() bool { return viewer.ConnectionState() == webrtc.PeerConnectionStateConnected })
	helper.mu.RLock()
	stats := snapshot(helper.sessions["preview"])
	helper.mu.RUnlock()
	if stats.SelectedCandidatePair == nil || !localAddress(stats.SelectedCandidatePair.LocalAddress) || stats.Admission.SubscriberBudgetBps != 0 {
		t.Fatalf("preview not local: %+v", stats)
	}
	publisher, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(publisher)
	track, err := webrtc.NewTrackLocalStaticRTP(vp8Capability(), "screen", "screen")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = publisher.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatal(err)
	}
	negotiateAdmitted(t, endpoint.URL, publisher, "publisher", "publish", admissionRequest{StreamBps: 40000000, SourceBudgetBps: 96000000, SubscriberBudgetBps: 0, Locality: "remote"})
	waitUntil(t, "publisher did not connect", func() bool { return publisher.ConnectionState() == webrtc.PeerConnectionStateConnected })
	for sequence := uint16(1); sequence <= 25; sequence++ {
		if err = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000, Marker: true}, Payload: []byte{0x10, 1, 2, 3}}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	waitUntil(t, "pre-negotiated preview received no real RTP", func() bool { return received.Load() > 5 })
	t.Logf("preview connected before publisher existed; acceptedStreamBps=40000000 real VP8 packets=%d helperLocal=%s", received.Load(), stats.SelectedCandidatePair.LocalAddress)
	helper.mu.RLock()
	pub := helper.sessions["publisher"]
	helper.mu.RUnlock()
	helper.remove(pub)
}

func TestAdmissionRejectsAggregateAcrossSources(t *testing.T) {
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
	negotiateAdmitted(t, endpoint.URL, pc, "first", "subscribe", admissionRequest{StreamBps: 128000, SubscriberBudgetBps: 300000, SourceBudgetBps: 500000, Locality: "remote"})
	request := offerRequest{ID: "second", NegotiationID: "second-negotiation", Role: "subscribe", Source: "another-source", SDP: *pc.LocalDescription(), Network: networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}, Admission: admissionRequest{StreamBps: 128000, SubscriberBudgetBps: 300000, SourceBudgetBps: 500000, Locality: "remote"}}
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(endpoint.URL+"/session", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var failure map[string]string
	if err = json.NewDecoder(response.Body).Decode(&failure); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 409 || !strings.Contains(failure["error"], "aggregate egress") {
		t.Fatalf("aggregate budget not rejected: %d %+v", response.StatusCode, failure)
	}
	helper.mu.RLock()
	first := helper.sessions["first"]
	helper.mu.RUnlock()
	for _, input := range []struct {
		budget int64
		status int
	}{{0, 409}, {300000, 200}, {600000, 200}} {
		body, err := json.Marshal(struct {
			SourceBudgetBps int64 `json:"sourceBudgetBps"`
		}{input.budget})
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.Post(endpoint.URL+"/budget", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != input.status {
			t.Fatalf("budget=%d status=%d want=%d", input.budget, response.StatusCode, input.status)
		}
	}
	helper.remove(first)
	response, err = http.Post(endpoint.URL+"/budget", "application/json", strings.NewReader(`{"sourceBudgetBps":0}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("zero budget after removal was rejected")
	}
	removal, err := http.NewRequest(http.MethodDelete, endpoint.URL+"/session/first", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.DefaultClient.Do(removal)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("repeat removal was not idempotent")
	}
	t.Log("real offer for another source rejected against helper-wide shared budget")
}

func TestRealOverloadClosesBoundedSubscriber(t *testing.T) {
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
	viewer, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(viewer)
	if _, err = viewer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	viewer.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			if _, _, err := track.ReadRTP(); err != nil {
				return
			}
		}
	})
	negotiateAdmitted(t, endpoint.URL, viewer, "slow-viewer", "subscribe", admissionRequest{StreamBps: 128000, SubscriberBudgetBps: 128000, SourceBudgetBps: 12000000, Locality: "remote"})
	publisher, err := client.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(publisher)
	track, err := webrtc.NewTrackLocalStaticRTP(vp8Capability(), "screen", "screen")
	if err != nil {
		t.Fatal(err)
	}
	transceiver, err := publisher.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			if _, _, err := transceiver.Sender().ReadRTCP(); err != nil {
				return
			}
		}
	}()
	negotiateAdmitted(t, endpoint.URL, publisher, "overload-publisher", "publish", admissionRequest{StreamBps: 128000, SubscriberBudgetBps: 0, SourceBudgetBps: 12000000, Locality: "remote"})
	waitUntil(t, "overload peers did not connect", func() bool {
		return viewer.ConnectionState() == webrtc.PeerConnectionStateConnected && publisher.ConnectionState() == webrtc.PeerConnectionStateConnected
	})
	payload := make([]byte, 1100)
	payload[0] = 0x10
	for sequence := uint16(1); sequence <= 700; sequence++ {
		if err = track.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000, Marker: true}, Payload: payload}); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond)
	}
	waitUntil(t, "overloaded subscriber was not removed", func() bool {
		helper.mu.RLock()
		defer helper.mu.RUnlock()
		return helper.sessions["slow-viewer"] == nil
	})
	helper.mu.RLock()
	var closed sessionStats
	for _, row := range helper.archive {
		if row.ID == "slow-viewer" {
			closed = row
		}
	}
	pub := helper.sessions["overload-publisher"]
	helper.mu.RUnlock()
	if !strings.HasPrefix(closed.Diagnostic, "egress_") || closed.WireRTPBytesSent > 100000 || closed.QueueBytes > 512<<10 {
		t.Fatalf("overload not bounded and explicit: %+v", closed)
	}
	t.Logf("real overload closed subscriber: diagnostic=%s wireBytes=%d queuedBytes=%d", closed.Diagnostic, closed.WireRTPBytesSent, closed.QueueBytes)
	helper.remove(pub)
}

func TestRealSessionChurnKeepsOnlyBoundedClosedDiagnostics(t *testing.T) {
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
	for index := 0; index < 20; index++ {
		pc, err := client.api.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
		negotiate(t, endpoint.URL, pc, "churn", "subscriber")
		helper.mu.RLock()
		peer := helper.sessions["churn"]
		helper.mu.RUnlock()
		helper.remove(peer)
		closePC(pc)
	}
	helper.mu.RLock()
	defer helper.mu.RUnlock()
	if len(helper.archive) != 16 || len(helper.sessions) != 0 {
		t.Fatalf("unbounded diagnostics: live=%d closed=%d", len(helper.sessions), len(helper.archive))
	}
	t.Log("20 real negotiated sessions leave 0 live sessions and exactly 16 bounded closed diagnostics")
}
