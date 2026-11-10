package main

import (
	"fmt"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const colorSpaceURI = "http://www.webrtc.org/experiments/rtp-hdrext/color-space"

func colorExtensionID(extensions []webrtc.RTPHeaderExtensionParameter) (uint8, error) {
	for _, extension := range extensions {
		if extension.URI != colorSpaceURI {
			continue
		}
		if extension.ID < 1 || extension.ID > 255 {
			return 0, fmt.Errorf("negotiated color-space extension ID %d is outside 1..255", extension.ID)
		}
		return uint8(extension.ID), nil
	}
	return 0, nil
}

// Preserve only negotiated color metadata; transport extensions belong to each PC.
func forwardColorSpace(packet *rtp.Packet, incomingID uint8, outgoingID uint8) (*rtp.Packet, error) {
	forwarded := packet.Clone()
	forwarded.Extension = false
	forwarded.Extensions = nil
	forwarded.ExtensionProfile = 0
	if incomingID == 0 || outgoingID == 0 {
		return forwarded, nil
	}
	color := packet.GetExtension(incomingID)
	if len(color) == 0 {
		return forwarded, nil
	}
	if len(color) != 4 && len(color) != 28 {
		return nil, fmt.Errorf("color-space extension has invalid length %d; expected 4 or 28 bytes at sequence %d", len(color), packet.SequenceNumber)
	}
	forwarded.Extension = true
	forwarded.ExtensionProfile = rtp.ExtensionProfileOneByte
	if outgoingID > 14 || len(color) > 16 {
		forwarded.ExtensionProfile = rtp.ExtensionProfileTwoByte
	}
	if err := forwarded.SetExtension(outgoingID, append([]byte{}, color...)); err != nil {
		return nil, fmt.Errorf("remap color-space extension %d to %d at sequence %d: %w", incomingID, outgoingID, packet.SequenceNumber, err)
	}
	return forwarded, nil
}
