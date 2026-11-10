package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestReceivedLedgerWrapIsolationAndExpiry(t *testing.T) {
	ledger, err := newReceivedLedger(64, 2)
	if err != nil {
		t.Fatal(err)
	}
	for _, sequence := range []uint16{65534, 0, 65535, 1} {
		observed, observeErr := ledger.observe(10, sequence)
		if observeErr != nil || observed != firstArrival {
			t.Fatalf("first arrival rejected across wrap: sequence=%d result=%d error=%v", sequence, observed, observeErr)
		}
	}
	observed, err := ledger.observe(10, 65535)
	if err != nil || observed != duplicateArrival {
		t.Fatalf("late duplicate was not detected: %d %v", observed, err)
	}
	observed, err = ledger.observe(11, 65535)
	if err != nil || observed != firstArrival {
		t.Fatalf("SSRCs shared sequence state: %d %v", observed, err)
	}
	for index := uint32(2); index < 70000; index++ {
		observed, err = ledger.observe(10, uint16(index))
		if err != nil || observed != firstArrival {
			t.Fatalf("stale slot aliased after wrap: index=%d result=%d error=%v", index, observed, err)
		}
	}
	old := uint16((69999 - 64) & 0xffff)
	observed, err = ledger.observe(10, old)
	if err != nil || observed != outsideWindowArrival {
		t.Fatalf("expired arrival must remain unclassified: %d %v", observed, err)
	}
	ledger.mu.RLock()
	defer ledger.mu.RUnlock()
	if ledger.containsLocked(10, old) || ledger.containsLocked(12, 65535) || !ledger.containsLocked(11, 65535) {
		t.Fatal("expired or unknown SSRC sequence was falsely classified as received")
	}
}

func TestRepairFilterKeepsUnreceivedAndOriginalCompound(t *testing.T) {
	ledger, err := newReceivedLedger(64, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ledger.observe(10, 65535); err != nil {
		t.Fatal(err)
	}
	if _, err = ledger.observe(10, 1); err != nil {
		t.Fatal(err)
	}
	state := &repairState{ledger: ledger}
	input := []rtcp.Packet{
		&rtcp.ReceiverReport{SSRC: 50},
		&rtcp.TransportLayerNack{SenderSSRC: 50, MediaSSRC: 10, Nacks: rtcp.NackPairsFromSequenceNumbers([]uint16{65535, 0, 1, 2})},
		&rtcp.TransportLayerNack{SenderSSRC: 50, MediaSSRC: 11, Nacks: []rtcp.NackPair{{PacketID: 65535}}},
	}
	before, err := rtcp.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	filtered := state.filter(input)
	after, err := rtcp.Marshal(input)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("filter mutated the original compound RTCP packets")
	}
	if len(filtered) != 3 || state.filteredRepairNacks.Load() != 2 {
		t.Fatalf("unexpected compound filtering result: packets=%d removed=%d", len(filtered), state.filteredRepairNacks.Load())
	}
	nack, ok := filtered[1].(*rtcp.TransportLayerNack)
	if !ok {
		t.Fatal("filtered packet is not NACK")
	}
	var remaining []uint16
	for _, pair := range nack.Nacks {
		pair.Range(func(sequence uint16) bool { remaining = append(remaining, sequence); return true })
	}
	if len(remaining) != 2 || remaining[0] != 0 || remaining[1] != 2 {
		t.Fatalf("unreceived sequences changed: %v", remaining)
	}
}

// This interceptor deliberately drops real outgoing packets before SRTP and
// duplicates a real RTX repair with a fresh repair sequence number.
type repairLossControl struct {
	interceptor.NoOp
	allowSecondRepair atomic.Bool
	firstRepairWrites atomic.Uint64
	secondRepairDrops atomic.Uint64
	originalDrops     atomic.Uint64
	mu                sync.Mutex
	sequencer         rtp.Sequencer
}

func (control *repairLossControl) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	return control, nil
}

func (control *repairLossControl) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if header.SSRC == info.SSRC && (header.SequenceNumber == 65535 || header.SequenceNumber == 20) {
			control.originalDrops.Add(1)
			return header.MarshalSize() + len(payload), nil
		}
		if header.SSRC != info.SSRCRetransmission {
			return writer.Write(header, payload, attributes)
		}
		if len(payload) < 2 {
			return 0, fmt.Errorf("RTX payload lacks OSN: bytes=%d", len(payload))
		}
		osn := binary.BigEndian.Uint16(payload)
		if osn == 20 && !control.allowSecondRepair.Load() {
			control.secondRepairDrops.Add(1)
			return header.MarshalSize() + len(payload), nil
		}
		control.mu.Lock()
		defer control.mu.Unlock()
		outgoing := header.Clone()
		outgoing.SequenceNumber = control.sequencer.NextSequenceNumber()
		n, err := writer.Write(&outgoing, payload, attributes)
		if err != nil {
			return n, err
		}
		if osn == 65535 && control.firstRepairWrites.Add(1) == 1 {
			outgoing.SequenceNumber = control.sequencer.NextSequenceNumber()
			if _, err = writer.Write(&outgoing, payload, attributes); err != nil {
				return n, err
			}
			control.firstRepairWrites.Add(1)
		}
		return n, nil
	})
}

func TestRealRTXRepairStopsNACKAndDuplicateFanout(t *testing.T) {
	lab, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	endpoint := httptest.NewServer(lab.routes())
	defer endpoint.Close()
	control := &repairLossControl{sequencer: rtp.NewRandomSequencer()}
	engine := &webrtc.MediaEngine{}
	if err = engine.RegisterDefaultCodecs(); err != nil {
		t.Fatal(err)
	}
	if err = engine.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: colorSpaceURI}, webrtc.RTPCodecTypeVideo); err != nil {
		t.Fatal(err)
	}
	registry := &interceptor.Registry{}
	registry.Add(control)
	if err = webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		t.Fatal(err)
	}
	settings := webrtc.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	publisherAPI := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(settings))
	publisher, err := publisherAPI.NewPeerConnection(webrtc.Configuration{})
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
	var firstNACKs, secondNACKs atomic.Uint64
	go func() {
		for {
			packets, _, readErr := sender.ReadRTCP()
			if readErr != nil {
				return
			}
			for _, packet := range packets {
				nack, ok := packet.(*rtcp.TransportLayerNack)
				if !ok {
					continue
				}
				for _, pair := range nack.Nacks {
					pair.Range(func(sequence uint16) bool {
						if sequence == 65535 {
							firstNACKs.Add(1)
						}
						if sequence == 20 {
							secondNACKs.Add(1)
						}
						return true
					})
				}
			}
		}
	}()
	negotiate(t, endpoint.URL, publisher, "repair-publisher", "publisher")
	if sender.GetParameters().Encodings[0].RTX.SSRC == 0 {
		t.Fatal("publisher did not negotiate a real RTX SSRC")
	}
	colorID, err := colorExtensionID(sender.GetParameters().HeaderExtensions)
	if err != nil || colorID == 0 {
		t.Fatalf("publisher color extension absent: %d %v", colorID, err)
	}
	waitUntil(t, "publisher ICE did not connect", func() bool { return publisher.ConnectionState() == webrtc.PeerConnectionStateConnected })
	writePacket := func(sequence uint16, timestamp uint32) error {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: sequence, Timestamp: timestamp, Marker: true}, Payload: []byte{0x10, 1, 2, 3, 4, 5}}
		if extensionErr := packet.SetExtension(colorID, []byte{1, 13, 1, 0x20}); extensionErr != nil {
			return extensionErr
		}
		return track.WriteRTP(packet)
	}
	if err = writePacket(65529, 88200); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "publisher track was not read", func() bool {
		lab.mu.RLock()
		defer lab.mu.RUnlock()
		return lab.sessions["repair-publisher"] != nil && lab.sessions["repair-publisher"].remote != nil
	})
	clientAPI, err := newServer()
	if err != nil {
		t.Fatal(err)
	}
	viewer, err := clientAPI.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer closePC(viewer)
	if _, err = viewer.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	var receivedFirst, receivedSecond atomic.Uint64
	viewer.OnTrack(func(remote *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		for {
			packet, _, readErr := remote.ReadRTP()
			if readErr != nil {
				return
			}
			if packet.SequenceNumber == 65535 {
				receivedFirst.Add(1)
			}
			if packet.SequenceNumber == 20 {
				receivedSecond.Add(1)
			}
		}
	})
	negotiate(t, endpoint.URL, viewer, "repair-viewer", "subscriber")
	waitUntil(t, "viewer ICE did not connect", func() bool { return viewer.ConnectionState() == webrtc.PeerConnectionStateConnected })
	lab.mu.RLock()
	pub := lab.sessions["repair-publisher"]
	sub := lab.sessions["repair-viewer"]
	lab.mu.RUnlock()
	stop := make(chan struct{})
	done := make(chan struct{})
	streamErrors := make(chan error, 1)
	var stopOnce sync.Once
	stopPump := func() { stopOnce.Do(func() { close(stop); <-done }) }
	defer stopPump()
	go func() {
		defer close(done)
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		index := uint32(0)
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if writeErr := writePacket(uint16(65530+index), 90000+index*1800); writeErr != nil {
					streamErrors <- writeErr
					return
				}
				index++
			}
		}
	}()
	waitUntil(t, "real loss did not trigger NACK and RTX repair", func() bool {
		return firstNACKs.Load() > 0 && receivedFirst.Load() > 0 && pub.wire.repair.duplicatePackets.Load() > 0 && control.secondRepairDrops.Load() > 0
	})
	// Allow an already in-flight RTCP request to arrive before the observation interval.
	time.Sleep(150 * time.Millisecond)
	firstBefore := firstNACKs.Load()
	secondBefore := secondNACKs.Load()
	time.Sleep(500 * time.Millisecond)
	if firstNACKs.Load() != firstBefore {
		t.Fatalf("successfully repaired OSN still requested over real RTCP: before=%d after=%d", firstBefore, firstNACKs.Load())
	}
	if secondNACKs.Load() <= secondBefore || receivedSecond.Load() != 0 {
		t.Fatalf("unreceived repair was hidden: NACK before=%d after=%d delivered=%d", secondBefore, secondNACKs.Load(), receivedSecond.Load())
	}
	if pub.wire.repair.filteredRepairNacks.Load() == 0 {
		t.Fatal("default generator RTCP did not pass through the repair filter")
	}
	control.allowSecondRepair.Store(true)
	waitUntil(t, "late first RTX repair was not forwarded", func() bool { return receivedSecond.Load() > 0 })
	time.Sleep(150 * time.Millisecond)
	secondAfterRepair := secondNACKs.Load()
	time.Sleep(300 * time.Millisecond)
	if secondNACKs.Load() != secondAfterRepair {
		t.Fatalf("newly repaired OSN continued NACKs: before=%d after=%d", secondAfterRepair, secondNACKs.Load())
	}
	// Stop input and wait for the receive/fanout counters to settle before comparing.
	stopPump()
	time.Sleep(100 * time.Millisecond)
	if pub.packets.Load()-pub.wire.repair.duplicatePackets.Load()-1 != sub.packets.Load() {
		t.Fatalf("duplicate repair reached fanout: input=%d duplicate=%d bootstrap=1 forwarded=%d", pub.packets.Load(), pub.wire.repair.duplicatePackets.Load(), sub.packets.Load())
	}
	if control.originalDrops.Load() != 2 || receivedFirst.Load() == 0 || receivedSecond.Load() == 0 {
		t.Fatalf("real loss setup did not exercise both OSNs: dropped=%d first=%d second=%d", control.originalDrops.Load(), receivedFirst.Load(), receivedSecond.Load())
	}
	select {
	case streamErr := <-streamErrors:
		t.Fatal(streamErr)
	default:
	}
	t.Logf("real RTP/RTX across wrap: originalDrops=%d repairWrites=%d deliberatelyDroppedRepairs=%d actualRTXReceived=%d duplicateSuppressed=%d forwarded=%d", control.originalDrops.Load(), control.firstRepairWrites.Load(), control.secondRepairDrops.Load(), pub.wire.repair.repairedPackets.Load(), pub.wire.repair.duplicatePackets.Load(), sub.packets.Load())
	t.Logf("real RTCP: repaired65535NACKs=%d stableDuring500ms; newMissing20NACKs=%d->%d; repaired20NACKs=%d stableDuring300ms; filteredRequests=%d filteredPackets=%d", firstBefore, secondBefore, secondAfterRepair, secondAfterRepair, pub.wire.repair.filteredRepairNacks.Load(), pub.wire.repair.filteredNackPackets.Load())
	lab.remove(pub)
}
