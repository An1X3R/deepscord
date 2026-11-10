package main

import (
	"bytes"
	"testing"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

func TestColorSpaceRemappingPreservesPayloadAndInput(t *testing.T) {
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: true, SequenceNumber: 123, Timestamp: 90000}, Payload: []byte{0x10, 1, 2, 3}}
	color := []byte{1, 13, 1, 0x20}
	if err := packet.SetExtension(9, color); err != nil {
		t.Fatal(err)
	}
	if err := packet.SetExtension(3, []byte{8, 9}); err != nil {
		t.Fatal(err)
	}
	before, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	forwarded, err := forwardColorSpace(packet, 9, 12)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(forwarded.GetExtension(12), color) {
		t.Fatal("color-space payload changed")
	}
	if len(forwarded.GetExtensionIDs()) != 1 || forwarded.GetExtension(3) != nil || forwarded.GetExtension(9) != nil {
		t.Fatal("unrelated or source extension IDs leaked")
	}
	if !bytes.Equal(packet.Payload, forwarded.Payload) || packet.Timestamp != forwarded.Timestamp || packet.SequenceNumber != forwarded.SequenceNumber {
		t.Fatal("encoded payload or RTP timeline changed")
	}
	after, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("input packet was mutated")
	}
	twoByte, err := forwardColorSpace(packet, 9, 18)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := twoByte.Marshal(); err != nil {
		t.Fatalf("high extension ID could not marshal: %v", err)
	}
	if twoByte.ExtensionProfile != rtp.ExtensionProfileTwoByte {
		t.Fatal("high extension ID requires two-byte profile")
	}
	forwarded.GetExtension(12)[0] = 99
	if !bytes.Equal(packet.GetExtension(9), color) {
		t.Fatal("extension payload aliases input memory")
	}
}

func TestColorSpaceHDRAndAbsentMetadata(t *testing.T) {
	packet := &rtp.Packet{Header: rtp.Header{Version: 2, Marker: true}, Payload: []byte{1, 2}}
	hdr := make([]byte, 28)
	hdr[0] = 9
	hdr[1] = 16
	hdr[2] = 9
	hdr[3] = 0x10
	if err := packet.SetExtensionWithProfile(7, hdr, rtp.ExtensionProfileTwoByte); err != nil {
		t.Fatal(err)
	}
	forwarded, err := forwardColorSpace(packet, 7, 18)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(forwarded.GetExtension(18), hdr) {
		t.Fatal("HDR metadata changed")
	}
	if len(forwarded.GetExtensionIDs()) != 1 {
		t.Fatal("unexpected HDR extensions")
	}
	absent, err := forwardColorSpace(packet, 7, 0)
	if err != nil {
		t.Fatal(err)
	}
	if absent.Extension {
		t.Fatal("unnegotiated metadata was forwarded")
	}
	if err := packet.SetExtensionWithProfile(7, []byte{1, 2, 3}, rtp.ExtensionProfileTwoByte); err != nil {
		t.Fatal(err)
	}
	if _, err := forwardColorSpace(packet, 7, 4); err == nil {
		t.Fatal("invalid color payload accepted")
	}
}

func TestColorExtensionIDUsesURI(t *testing.T) {
	id, err := colorExtensionID([]webrtc.RTPHeaderExtensionParameter{{URI: "urn:ietf:params:rtp-hdrext:sdes:mid", ID: 9}, {URI: colorSpaceURI, ID: 12}})
	if err != nil || id != 12 {
		t.Fatalf("URI mapping failed: id=%d error=%v", id, err)
	}
	if _, err := colorExtensionID([]webrtc.RTPHeaderExtensionParameter{{URI: colorSpaceURI, ID: 256}}); err == nil {
		t.Fatal("invalid extension ID accepted")
	}
}
