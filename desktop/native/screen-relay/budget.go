package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
)

type budgetRequest struct {
	SourceBudgetBps *int64 `json:"sourceBudgetBps"`
}
type budgetResponse struct {
	SourceBudgetBps int64 `json:"sourceBudgetBps"`
	AdmittedBps     int64 `json:"admittedBps"`
}

func (s *server) admittedLocked() int64 {
	var total int64
	for _, peer := range s.sessions {
		total += peer.admission.SubscriberBudgetBps
	}
	return total
}

func (s *server) updateBudget(w http.ResponseWriter, r *http.Request) {
	var request budgetRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		fail(w, 400, fmt.Errorf("invalid budget JSON: %w", err))
		return
	}
	var extra budgetRequest
	if err := decoder.Decode(&extra); err != io.EOF {
		fail(w, 400, errors.New("budget request requires exactly one JSON object"))
		return
	}
	if request.SourceBudgetBps == nil || *request.SourceBudgetBps < 0 || *request.SourceBudgetBps > 1000000000 {
		fail(w, 400, errors.New("sourceBudgetBps must be an explicit integer in 0..1000000000"))
		return
	}
	s.mu.Lock()
	admitted := s.admittedLocked()
	if admitted > *request.SourceBudgetBps {
		s.mu.Unlock()
		fail(w, 409, fmt.Errorf("budget reduction exceeds admitted subscriptions: admittedBps=%d requestedBudgetBps=%d; remove subscriptions first", admitted, *request.SourceBudgetBps))
		return
	}
	previous := s.budgetBps
	s.budgetBps = *request.SourceBudgetBps
	s.budgetSet = true
	for _, peer := range s.sessions {
		peer.admission.SourceBudgetBps = s.budgetBps
	}
	result := budgetResponse{SourceBudgetBps: s.budgetBps, AdmittedBps: admitted}
	s.mu.Unlock()
	slog.Info("screen_budget_changed", "previousBps", previous, "sourceBudgetBps", result.SourceBudgetBps, "admittedBps", admitted)
	writeJSON(w, 200, result)
}
