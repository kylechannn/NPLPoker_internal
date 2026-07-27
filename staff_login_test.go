package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestStaffQRChallengeApprovalIsSingleUse(t *testing.T) {
	manager := newStaffLoginManager("http://192.168.10.25:8790")
	mux := http.NewServeMux()
	manager.register(mux)

	createRequest := httptest.NewRequest(http.MethodPost, "/api/staff-login/challenges", nil)
	createRequest.Header.Set("X-NPL-Gateway", "desktop")
	createResponse := httptest.NewRecorder()
	mux.ServeHTTP(createResponse, createRequest)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("expected challenge creation, got %d: %s", createResponse.Code, createResponse.Body.String())
	}

	var created staffChallengeCreateResponse
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode challenge: %v", err)
	}
	if created.ID == "" || len(created.PairingCode) != 6 || !strings.HasPrefix(created.LoginURL, "http://192.168.10.25:8790/staff-login?t=") {
		t.Fatalf("unexpected challenge: %+v", created)
	}
	loginURL, err := url.Parse(created.LoginURL)
	if err != nil {
		t.Fatalf("parse login URL: %v", err)
	}
	token := loginURL.Query().Get("t")

	scanRequest := httptest.NewRequest(http.MethodGet, "/staff-login?t="+url.QueryEscape(token), nil)
	scanRequest.Header.Set("X-NPL-Gateway", "staff")
	scanResponse := httptest.NewRecorder()
	mux.ServeHTTP(scanResponse, scanRequest)
	if scanResponse.Code != http.StatusOK || !strings.Contains(scanResponse.Body.String(), "6-digit pairing code") {
		t.Fatalf("expected mobile login form, got %d: %s", scanResponse.Code, scanResponse.Body.String())
	}

	form := url.Values{
		"token":        {token},
		"pairing_code": {created.PairingCode},
		"staff_id":     {"npl-2048"},
		"staff_name":   {"Alex Morgan"},
		"staff_role":   {"Floor Manager"},
	}
	approveRequest := httptest.NewRequest(
		http.MethodPost,
		"/staff-login/approve",
		strings.NewReader(form.Encode()),
	)
	approveRequest.Header.Set("X-NPL-Gateway", "staff")
	approveRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	approveResponse := httptest.NewRecorder()
	mux.ServeHTTP(approveResponse, approveRequest)
	if approveResponse.Code != http.StatusOK || !strings.Contains(approveResponse.Body.String(), "Staff sign-in approved") {
		t.Fatalf("expected approval, got %d: %s", approveResponse.Code, approveResponse.Body.String())
	}
	if len(approveResponse.Result().Cookies()) != 1 || !approveResponse.Result().Cookies()[0].HttpOnly {
		t.Fatal("expected an HttpOnly staff session cookie")
	}

	statusRequest := httptest.NewRequest(http.MethodGet, "/api/staff-login/challenges/"+created.ID, nil)
	statusRequest.Header.Set("X-NPL-Gateway", "desktop")
	statusResponse := httptest.NewRecorder()
	mux.ServeHTTP(statusResponse, statusRequest)

	var status staffChallengeStatusResponse
	if err := json.Unmarshal(statusResponse.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode challenge status: %v", err)
	}
	if status.Status != "approved" || status.Staff == nil || status.Staff.ID != "NPL-2048" {
		t.Fatalf("unexpected approved status: %+v", status)
	}

	replayRequest := httptest.NewRequest(
		http.MethodPost,
		"/staff-login/approve",
		strings.NewReader(form.Encode()),
	)
	replayRequest.Header.Set("X-NPL-Gateway", "staff")
	replayRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	replayResponse := httptest.NewRecorder()
	mux.ServeHTTP(replayResponse, replayRequest)
	if replayResponse.Code != http.StatusGone {
		t.Fatalf("expected replay to be rejected, got %d", replayResponse.Code)
	}
}

func TestStaffGatewayCannotCreateDesktopChallenge(t *testing.T) {
	manager := newStaffLoginManager("http://192.168.10.25:8790")
	mux := http.NewServeMux()
	manager.register(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/staff-login/challenges", nil)
	request.Header.Set("X-NPL-Gateway", "staff")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("expected staff gateway to hide desktop route, got %d", response.Code)
	}
}

func TestWrongPairingCodeDoesNotApproveChallenge(t *testing.T) {
	manager := newStaffLoginManager("http://192.168.10.25:8790")
	mux := http.NewServeMux()
	manager.register(mux)

	createRequest := httptest.NewRequest(http.MethodPost, "/api/staff-login/challenges", nil)
	createRequest.Header.Set("X-NPL-Gateway", "desktop")
	createResponse := httptest.NewRecorder()
	mux.ServeHTTP(createResponse, createRequest)
	var created staffChallengeCreateResponse
	_ = json.Unmarshal(createResponse.Body.Bytes(), &created)
	loginURL, _ := url.Parse(created.LoginURL)

	form := url.Values{
		"token":        {loginURL.Query().Get("t")},
		"pairing_code": {"999999"},
		"staff_id":     {"NPL-2048"},
		"staff_name":   {"Alex Morgan"},
		"staff_role":   {"Floor Manager"},
	}
	request := httptest.NewRequest(http.MethodPost, "/staff-login/approve", strings.NewReader(form.Encode()))
	request.Header.Set("X-NPL-Gateway", "staff")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "does not match") {
		t.Fatalf("expected pairing rejection, got %d: %s", response.Code, response.Body.String())
	}
}
