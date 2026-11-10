package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/pion/ice/v4"
	"github.com/pion/sdp/v3"
	"github.com/pion/webrtc/v4"
)

const candidateLimit = 128

var negotiationIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

type candidateJSON struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex"`
	UsernameFragment *string `json:"usernameFragment"`
}

// Pointer fields are nullable, but every field must be explicitly present.
func (candidate *candidateJSON) UnmarshalJSON(data []byte) error {
	type wireCandidate candidateJSON
	var wire wireCandidate
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, name := range []string{"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"} {
		value, exists := fields[name]
		if !exists || (name == "candidate" && bytes.Equal(value, []byte("null"))) {
			return fmt.Errorf("candidate.%s must be explicitly present", name)
		}
	}
	*candidate = candidateJSON(wire)
	return candidate.validateShape()
}

func (candidate candidateJSON) validateShape() error {
	if len(candidate.Candidate) > 4096 || strings.ContainsAny(candidate.Candidate, "\r\n\x00") {
		return errors.New("candidate must be a single line of at most 4096 bytes")
	}
	if candidate.SDPMid != nil && (len(*candidate.SDPMid) == 0 || len(*candidate.SDPMid) > 128) {
		return errors.New("candidate.sdpMid must be null or a bounded nonempty string")
	}
	if candidate.SDPMLineIndex != nil && *candidate.SDPMLineIndex != 0 {
		return errors.New("candidate.sdpMLineIndex must identify the only video section (0)")
	}
	if candidate.UsernameFragment != nil && (len(*candidate.UsernameFragment) == 0 || len(*candidate.UsernameFragment) > 256) {
		return errors.New("candidate.usernameFragment must be null or a bounded nonempty string")
	}
	return nil
}

func remoteICEIdentity(raw string) (string, string, error) {
	var description sdp.SessionDescription
	if err := description.Unmarshal([]byte(raw)); err != nil {
		return "", "", fmt.Errorf("invalid ICE SDP: %w", err)
	}
	if len(description.MediaDescriptions) != 1 {
		return "", "", errors.New("ICE requires exactly one video section")
	}
	media := description.MediaDescriptions[0]
	mid, hasMid := media.Attribute("mid")
	ufrag, hasUfrag := media.Attribute("ice-ufrag")
	if !hasUfrag {
		ufrag, hasUfrag = description.Attribute("ice-ufrag")
	}
	if !hasMid || mid == "" || len(mid) > 128 || !hasUfrag || ufrag == "" || len(ufrag) > 256 {
		return "", "", errors.New("ICE SDP requires bounded mid and ice-ufrag")
	}
	return mid, ufrag, nil
}

func (s *server) recordCandidate(peer *session, candidate *webrtc.ICECandidate) {
	if peer.ctx.Err() != nil {
		return
	}
	value := candidateJSON{}
	if candidate != nil {
		wire := candidate.ToJSON()
		value = candidateJSON{Candidate: wire.Candidate, SDPMid: wire.SDPMid, SDPMLineIndex: wire.SDPMLineIndex}
		parameters, err := peer.pc.SCTP().Transport().ICETransport().GetLocalParameters()
		if err != nil {
			go s.failSession(peer, "local_ice_parameters_unavailable")
			return
		}
		value.UsernameFragment = &parameters.UsernameFragment
	}
	peer.iceMu.Lock()
	if peer.localComplete || peer.ctx.Err() != nil {
		peer.iceMu.Unlock()
		return
	}
	if len(peer.localCandidates) >= candidateLimit {
		peer.iceMu.Unlock()
		go s.failSession(peer, "local_ice_candidate_limit_exceeded")
		return
	}
	peer.localCandidates = append(peer.localCandidates, value)
	peer.localComplete = candidate == nil
	peer.iceMu.Unlock()
}

type candidateResponse struct {
	ID            string          `json:"id"`
	NegotiationID string          `json:"negotiationId"`
	After         int             `json:"after"`
	Next          int             `json:"next"`
	Candidates    []candidateJSON `json:"candidates"`
	Complete      bool            `json:"complete"`
}

func (s *server) candidates(w http.ResponseWriter, r *http.Request) {
	after, err := strconv.Atoi(r.URL.Query().Get("after"))
	nonce := r.URL.Query().Get("negotiationId")
	if err != nil || after < 0 || after > candidateLimit || !negotiationIDPattern.MatchString(nonce) {
		fail(w, 400, errors.New("ICE polling requires bounded after and negotiationId"))
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	peer := s.sessions[r.PathValue("id")]
	if peer == nil || peer.negotiationID != nonce {
		fail(w, 409, errors.New("ICE session or negotiationId is no longer current"))
		return
	}
	peer.iceMu.Lock()
	defer peer.iceMu.Unlock()
	if after > len(peer.localCandidates) {
		fail(w, 400, errors.New("ICE cursor exceeds the current candidate count"))
		return
	}
	values := append(make([]candidateJSON, 0, len(peer.localCandidates)-after), peer.localCandidates[after:]...)
	writeJSON(w, 200, candidateResponse{ID: peer.id, NegotiationID: nonce, After: after, Next: len(peer.localCandidates), Candidates: values, Complete: peer.localComplete})
}

func (s *server) addCandidate(w http.ResponseWriter, r *http.Request) {
	var request struct {
		NegotiationID string         `json:"negotiationId"`
		Candidate     *candidateJSON `json:"candidate"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		fail(w, 400, fmt.Errorf("invalid ICE JSON: %w", err))
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF || request.Candidate == nil || !negotiationIDPattern.MatchString(request.NegotiationID) {
		fail(w, 400, errors.New("ICE requires one JSON object, candidate and negotiationId"))
		return
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	peer := s.sessions[r.PathValue("id")]
	if peer == nil || peer.negotiationID != request.NegotiationID {
		fail(w, 409, errors.New("ICE session or negotiationId is no longer current"))
		return
	}
	peer.iceMu.Lock()
	defer peer.iceMu.Unlock()
	if !peer.remoteReady || peer.ctx.Err() != nil || peer.remoteComplete {
		fail(w, 409, errors.New("ICE session is not accepting remote candidates"))
		return
	}
	if peer.remoteCandidates >= candidateLimit {
		fail(w, 429, errors.New("remote ICE candidate limit of 128 exceeded"))
		return
	}
	value := request.Candidate
	if err := validateRemoteCandidate(peer, *value); err != nil {
		fail(w, 400, err)
		return
	}
	if err := peer.pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: value.Candidate, SDPMid: value.SDPMid, SDPMLineIndex: value.SDPMLineIndex, UsernameFragment: value.UsernameFragment}); err != nil {
		fail(w, 400, fmt.Errorf("remote ICE candidate rejected: %w", err))
		return
	}
	peer.remoteCandidates++
	peer.remoteComplete = value.Candidate == ""
	writeJSON(w, 200, map[string]string{"id": peer.id, "negotiationId": peer.negotiationID})
}

func validateRemoteCandidate(peer *session, value candidateJSON) error {
	if err := value.validateShape(); err != nil {
		return err
	}
	if value.SDPMid != nil && *value.SDPMid != peer.remoteMid {
		return errors.New("candidate.sdpMid does not match the negotiated video section")
	}
	if value.UsernameFragment != nil && *value.UsernameFragment != peer.remoteUfrag {
		return errors.New("candidate.usernameFragment does not match the remote SDP")
	}
	if value.Candidate == "" {
		return nil
	}
	if value.UsernameFragment == nil || (value.SDPMid == nil && value.SDPMLineIndex == nil) {
		return errors.New("nonempty candidates require remote usernameFragment and a video mid or index")
	}
	if !strings.HasPrefix(value.Candidate, "candidate:") {
		return errors.New("candidate must use the candidate: prefix")
	}
	parsed, err := ice.UnmarshalCandidate(strings.TrimPrefix(value.Candidate, "candidate:"))
	if err != nil {
		return fmt.Errorf("invalid ICE candidate: %w", err)
	}
	if fragment, exists := parsed.GetExtension("ufrag"); exists && fragment.Value != peer.remoteUfrag {
		return errors.New("candidate text ufrag does not match the remote SDP")
	}
	if peer.admission.Locality == "loopback-preview" && (parsed.Type() != ice.CandidateTypeHost || !localAddress(parsed.Address())) {
		return errors.New("preview candidates must be literal host addresses of this computer")
	}
	return nil
}
