package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func negotiate(t *testing.T, endpoint string, pc *webrtc.PeerConnection, id string, role string) {
	t.Helper()
	wireRole := "subscribe"
	budget := int64(4000000)
	if role == "publisher" {
		wireRole = "publish"
		budget = 0
	}
	negotiateAdmitted(t, endpoint, pc, id, wireRole, admissionRequest{StreamBps: 2500000, SubscriberBudgetBps: budget, SourceBudgetBps: 12000000, Locality: "remote"})
}

func negotiateAdmitted(t *testing.T, endpoint string, pc *webrtc.PeerConnection, id string, role string, admission admissionRequest) {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(10 * time.Second):
		t.Fatal("client ICE gathering timeout")
	}
	nonce := id + "-negotiation"
	body, err := json.Marshal(offerRequest{ID: id, NegotiationID: nonce, Role: role, Source: "screen", SDP: *pc.LocalDescription(), Network: networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}, Admission: admission})
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.Post(endpoint+"/session", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		var failure map[string]string
		if err = json.NewDecoder(response.Body).Decode(&failure); err != nil {
			t.Fatal(err)
		}
		t.Fatalf("offer rejected: %d %v", response.StatusCode, failure)
	}
	var answer answerResponse
	if err = json.NewDecoder(response.Body).Decode(&answer); err != nil {
		t.Fatal(err)
	}
	if answer.SDP == nil || answer.NegotiationID != nonce {
		t.Fatal("answer SDP missing")
	}
	if err = pc.SetRemoteDescription(*answer.SDP); err != nil {
		t.Fatal(err)
	}
	consumeNativeCandidates(t, endpoint, pc, id, nonce)
}

func TestExplicitNetworkConfiguration(t *testing.T) {
	valid := networkRequest{ICEServers: []iceServerRequest{}, Policy: "all"}
	config, err := configuration(valid)
	if err != nil || config.ICETransportPolicy != webrtc.ICETransportPolicyAll {
		t.Fatalf("explicit host config rejected: %v", err)
	}
	relay := networkRequest{ICEServers: []iceServerRequest{{URLs: []string{"turn:127.0.0.1:3478?transport=udp"}, Username: "lab", Credential: "lab-secret"}}, Policy: "relay"}
	config, err = configuration(relay)
	if err != nil || config.ICETransportPolicy != webrtc.ICETransportPolicyRelay || len(config.ICEServers) != 1 {
		t.Fatalf("explicit relay config rejected: %v", err)
	}
	invalid := []networkRequest{
		{},
		{ICEServers: []iceServerRequest{}, Policy: ""},
		{ICEServers: []iceServerRequest{}, Policy: "relay"},
		{ICEServers: []iceServerRequest{{URLs: []string{"turn:127.0.0.1:3478"}}}, Policy: "relay"},
		{ICEServers: []iceServerRequest{{URLs: []string{"http://127.0.0.1:3478"}}}, Policy: "all"},
		{ICEServers: []iceServerRequest{{URLs: []string{}}}, Policy: "all"},
	}
	for index, request := range invalid {
		if _, err = configuration(request); err == nil {
			t.Fatalf("invalid network case %d accepted", index)
		}
	}
}

func waitUntil(t *testing.T, description string, check func() bool) {
	t.Helper()
	timeout := time.NewTimer(10 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if check() {
			return
		}
		select {
		case <-timeout.C:
			t.Fatal(description)
		case <-ticker.C:
		}
	}
}

func TestRealRTPFanoutAndRecovery(t *testing.T) {
	lab, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(lab.routes())
	defer endpoint.Close()
	clientAPI, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	publisher, err := clientAPI.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(publisher)
	track, err := webrtc.NewTrackLocalStaticRTP(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000}, "screen", "screen")
	if err != nil {
		t.Fatal(err)
	}
	transceiver, err := publisher.AddTransceiverFromTrack(track, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
	if err != nil {
		t.Fatal(err)
	}
	sender := transceiver.Sender()
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	negotiate(t, endpoint.URL, publisher, "publisher", "publisher")
	inputColorID, idErr := colorExtensionID(sender.GetParameters().HeaderExtensions)
	if idErr != nil || inputColorID == 0 {
		t.Fatalf("publisher color-space negotiation failed: %d %v", inputColorID, idErr)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	payload := []byte{0x10, 0x01, 0x02, 0x03, 0x04, 0x05}
	color := []byte{1, 13, 1, 0x20}
	streamErrors := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		var sequence uint16
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sequence++
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence, Timestamp: uint32(sequence) * 1800, SSRC: 12345, Marker: true}, Payload: payload}
				if err := packet.SetExtension(inputColorID, color); err != nil {
					streamErrors <- err
					return
				}
				err := track.WriteRTP(packet)
				if err != nil {
					streamErrors <- err
					return
				}
			}
		}
	}()
	waitUntil(t, "publisher track not ready", func() bool {
		lab.mu.RLock()
		defer lab.mu.RUnlock()
		peer := lab.sessions["publisher"]
		return peer != nil && peer.remote != nil
	})
	var received [2]atomic.Uint64
	var remoteSSRC [2]atomic.Uint32
	var lastSequence [2]atomic.Uint32
	consumers := make([]*webrtc.PeerConnection, 0, 2)
	for index := range received {
		consumer, createErr := clientAPI.api.NewPeerConnection(webrtc.Configuration{})
		if createErr != nil {
			t.Fatal(createErr)
		}
		defer closePC(consumer)
		consumers = append(consumers, consumer)
		if _, err = consumer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
		consumer.OnTrack(func(remote *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
			outputColorID, idErr := colorExtensionID(receiver.GetParameters().HeaderExtensions)
			if idErr != nil || outputColorID == 0 {
				select {
				case streamErrors <- fmt.Errorf("subscriber %d missing color extension negotiation: %v", index, idErr):
				default:
				}
				return
			}
			remoteSSRC[index].Store(uint32(remote.SSRC()))
			for {
				packet, _, readErr := remote.ReadRTP()
				if readErr != nil {
					return
				}
				if !bytes.Equal(packet.Payload, payload) {
					select {
					case streamErrors <- fmt.Errorf("payload changed for subscriber %d", index):
					default:
					}
					return
				}
				if !bytes.Equal(packet.GetExtension(outputColorID), color) {
					select {
					case streamErrors <- fmt.Errorf("subscriber %d color payload changed", index):
					default:
					}
					return
				}
				lastSequence[index].Store(uint32(packet.SequenceNumber))
				received[index].Add(1)
			}
		})
		negotiate(t, endpoint.URL, consumer, fmt.Sprintf("subscriber-%d", index), "subscriber")
	}
	waitUntil(t, "fanout did not deliver to both subscribers", func() bool { return received[0].Load() > 5 && received[1].Load() > 5 })
	lab.mu.RLock()
	pub := lab.sessions["publisher"]
	first := lab.sessions["subscriber-0"]
	second := lab.sessions["subscriber-1"]
	t.Logf("real RTP fanout: publisher packets=%d bytes=%d; sub0=%d sub1=%d; codec=%s", pub.packets.Load(), pub.bytes.Load(), received[0].Load(), received[1].Load(), pub.remote.Codec().MimeType)
	lab.mu.RUnlock()
	if pub.pli.Load() == 0 {
		t.Fatal("join did not request upstream keyframe")
	}
	if pub.colorPackets.Load() == 0 || first.colorPackets.Load() == 0 || second.colorPackets.Load() == 0 {
		t.Fatal("real color metadata was not counted across fanout")
	}
	if err = consumers[0].WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: remoteSSRC[0].Load()}, &rtcp.TransportLayerNack{MediaSSRC: remoteSSRC[0].Load(), Nacks: []rtcp.NackPair{{PacketID: uint16(lastSequence[0].Load())}}}}); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "subscriber PLI/NACK not observed", func() bool { return first.pli.Load() > 0 && first.nack.Load() > 0 })
	waitUntil(t, "NACK did not cause a real RTP retransmission", func() bool { return first.wire.packetsSent.Load() > first.packets.Load() })
	t.Logf("real RTCP: subscriber pli=%d nack=%d upstream pli=%d", first.pli.Load(), first.nack.Load(), pub.pli.Load())
	t.Logf("real RTP meter includes retransmission: logicalPackets=%d wirePackets=%d wireBytes=%d", first.packets.Load(), first.wire.packetsSent.Load(), first.wire.sent.Load())
	statsResponse, err := http.Get(endpoint.URL + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	var measured serverStats
	if err = json.NewDecoder(statsResponse.Body).Decode(&measured); err != nil {
		statsResponse.Body.Close()
		t.Fatal(err)
	}
	statsResponse.Body.Close()
	if statsResponse.StatusCode != 200 {
		t.Fatalf("stats HTTP status %d", statsResponse.StatusCode)
	}
	if measured.CPUTimeStatus == "available" && (measured.CPUTimeSeconds == nil || *measured.CPUTimeSeconds <= 0) {
		t.Fatal("available CPU time is missing or nonpositive")
	}
	for _, peer := range measured.Sessions {
		if peer.SelectedCandidatePair == nil {
			t.Fatalf("connected session %s selected pair missing", peer.ID)
		}
		pair := peer.SelectedCandidatePair
		if (pair.LocalCandidateType != "host" && pair.LocalCandidateType != "prflx") || (pair.RemoteCandidateType != "host" && pair.RemoteCandidateType != "prflx") || pair.LocalProtocol != "udp" || pair.RemoteProtocol != "udp" {
			t.Fatalf("unexpected direct ICE pair: %+v", pair)
		}
		t.Logf("verified session %s selected pair: local=%s/%s remote=%s/%s", peer.ID, pair.LocalCandidateType, pair.LocalProtocol, pair.RemoteCandidateType, pair.RemoteProtocol)
	}
	if measured.CPUTimeSeconds != nil {
		t.Logf("process cumulative CPU seconds=%f", *measured.CPUTimeSeconds)
	}
	subscriberCount := received[1].Load()
	lab.remove(first)
	waitUntil(t, "remaining subscriber stopped after sibling disconnect", func() bool { return received[1].Load() > subscriberCount+3 })
	lab.remove(pub)
	lab.mu.RLock()
	count := len(lab.sessions)
	lab.mu.RUnlock()
	if count != 0 {
		t.Fatalf("publisher disconnect left %d live sessions", count)
	}
	if second.pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatal("publisher disconnect did not close subscriber")
	}
	select {
	case streamErr := <-streamErrors:
		t.Fatal(streamErr)
	default:
	}
	t.Log("subscriber isolation and publisher cascade cleanup passed")
}
