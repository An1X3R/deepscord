package main

import (
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
)

type arrival uint8

const (
	firstArrival arrival = iota
	duplicateArrival
	outsideWindowArrival
)

type sequenceSlot struct {
	sequence uint16
	valid    bool
}

type sequenceWindow struct {
	newest uint16
	slots  []sequenceSlot
}

// Sequence order is defined only within half of the 16-bit sequence space.
// Older untracked packets remain eligible for forwarding and NACK requests.
type receivedLedger struct {
	mu          sync.RWMutex
	streams     map[uint32]*sequenceWindow
	windowSize  uint16
	streamLimit int
}

func newReceivedLedger(windowSize uint16, streamLimit int) (*receivedLedger, error) {
	if windowSize == 0 || windowSize > 16384 || windowSize&(windowSize-1) != 0 || streamLimit < 1 {
		return nil, fmt.Errorf("invalid repair ledger configuration: windowSize=%d must be a power of two in 1..16384; streamLimit=%d must be positive", windowSize, streamLimit)
	}
	return &receivedLedger{streams: make(map[uint32]*sequenceWindow), windowSize: windowSize, streamLimit: streamLimit}, nil
}

func (ledger *receivedLedger) observe(ssrc uint32, sequence uint16) (arrival, error) {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	window := ledger.streams[ssrc]
	if window == nil {
		if len(ledger.streams) >= ledger.streamLimit {
			return outsideWindowArrival, fmt.Errorf("repair ledger SSRC limit exceeded: ssrc=%d streamLimit=%d", ssrc, ledger.streamLimit)
		}
		window = &sequenceWindow{newest: sequence, slots: make([]sequenceSlot, ledger.windowSize)}
		ledger.streams[ssrc] = window
	} else {
		forward := sequence - window.newest
		if forward != 0 && forward < 1<<15 {
			if forward >= ledger.windowSize {
				clear(window.slots)
			} else {
				for step := uint16(1); step <= forward; step++ {
					window.slots[(window.newest+step)%ledger.windowSize].valid = false
				}
			}
			window.newest = sequence
		} else if window.newest-sequence >= ledger.windowSize {
			return outsideWindowArrival, nil
		}
	}
	slot := &window.slots[sequence%ledger.windowSize]
	if slot.valid && slot.sequence == sequence {
		return duplicateArrival, nil
	}
	*slot = sequenceSlot{sequence: sequence, valid: true}
	return firstArrival, nil
}

// containsLocked never treats an expired or unseen sequence as received.
func (ledger *receivedLedger) containsLocked(ssrc uint32, sequence uint16) bool {
	window := ledger.streams[ssrc]
	if window == nil || window.newest-sequence >= ledger.windowSize {
		return false
	}
	slot := window.slots[sequence%ledger.windowSize]
	return slot.valid && slot.sequence == sequence
}

type repairState struct {
	ledger               *receivedLedger
	repairedPackets      atomic.Uint64
	duplicatePackets     atomic.Uint64
	outsideWindowPackets atomic.Uint64
	filteredRepairNacks  atomic.Uint64
	filteredNackPackets  atomic.Uint64
}

type repairFactory struct{ state *repairState }
type repairInterceptor struct {
	interceptor.NoOp
	state *repairState
}

func (factory *repairFactory) NewInterceptor(_ string) (interceptor.Interceptor, error) {
	return &repairInterceptor{state: factory.state}, nil
}

func (state *repairState) filter(packets []rtcp.Packet) []rtcp.Packet {
	state.ledger.mu.RLock()
	defer state.ledger.mu.RUnlock()
	filtered := make([]rtcp.Packet, 0, len(packets))
	for _, packet := range packets {
		nack, ok := packet.(*rtcp.TransportLayerNack)
		if !ok {
			filtered = append(filtered, packet)
			continue
		}
		missing := make([]uint16, 0, len(nack.Nacks))
		removed := uint64(0)
		for _, pair := range nack.Nacks {
			pair.Range(func(sequence uint16) bool {
				if state.ledger.containsLocked(nack.MediaSSRC, sequence) {
					removed++
				} else {
					missing = append(missing, sequence)
				}
				return true
			})
		}
		state.filteredRepairNacks.Add(removed)
		if removed == 0 {
			filtered = append(filtered, packet)
		} else if len(missing) != 0 {
			filtered = append(filtered, &rtcp.TransportLayerNack{SenderSSRC: nack.SenderSSRC, MediaSSRC: nack.MediaSSRC, Nacks: rtcp.NackPairsFromSequenceNumbers(missing)})
		} else {
			state.filteredNackPackets.Add(1)
		}
	}
	return filtered
}

// Register this before the default NACK generator: its captured writer must
// include this egress filter. Only authenticated packets read by the application
// populate the ledger; an unreceived repair never suppresses a real request.
func (filter *repairInterceptor) BindRTCPWriter(writer interceptor.RTCPWriter) interceptor.RTCPWriter {
	return interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, attributes interceptor.Attributes) (int, error) {
		filtered := filter.state.filter(packets)
		if len(filtered) == 0 {
			return 0, nil
		}
		return writer.Write(filtered, attributes)
	})
}
