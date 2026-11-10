package main

import (
	"net/http/httptest"
	"testing"

	"github.com/pion/webrtc/v4"
)

func TestHighScreenAdmissionRetainsAggregateBudget(t *testing.T) {
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
	negotiateAdmitted(t, endpoint.URL, viewer, "high-subscriber", "subscribe", admissionRequest{StreamBps: 40000000, SubscriberBudgetBps: 48000000, SourceBudgetBps: 48000000, Locality: "remote"})
	waitUntil(t, "high admission subscriber did not connect", func() bool { return viewer.ConnectionState() == webrtc.PeerConnectionStateConnected })
	request := offerRequest{ID: "next-high-subscriber", Role: "subscribe", Source: "other-source", SDP: *viewer.LocalDescription(), Network: networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}, Admission: admissionRequest{StreamBps: 40000000, SubscriberBudgetBps: 48000000, SourceBudgetBps: 48000000, Locality: "remote"}}
	if err = validateMediaOffer(request); err != nil {
		t.Fatal(err)
	}
	helper.mu.Lock()
	err = helper.admitLocked(request)
	helper.mu.Unlock()
	if err == nil {
		t.Fatal("aggregate admission accepted a second 48 Mbps subscriber above the 48 Mbps helper budget")
	}
	for _, rates := range []admissionRequest{
		{StreamBps: 40000001, SubscriberBudgetBps: 48000000, SourceBudgetBps: 96000000, Locality: "remote"},
		{StreamBps: 40000000, SubscriberBudgetBps: 48000001, SourceBudgetBps: 96000000, Locality: "remote"},
	} {
		request.Admission = rates
		if err = validateMediaOffer(request); err == nil {
			t.Fatalf("out-of-range screen rates accepted: %+v", rates)
		}
	}
	t.Log("real subscriber negotiated 40 Mbps media / 48 Mbps wire admission; aggregate and upper bounds rejected")
	helper.mu.RLock()
	peer := helper.sessions["high-subscriber"]
	helper.mu.RUnlock()
	helper.remove(peer)
}
