package main

import (
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
)

func TestHealthEndpoint(t *testing.T) {
	handler := newHandler(testAssets())
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body healthResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.OK || body.Service != appName {
		t.Fatalf("unexpected health response: %+v", body)
	}
	if body.StaffConsoleLogin {
		t.Fatal("expected no console-login demand while no bundled backend exists")
	}
	if response.Header().Get("X-Request-ID") == "" {
		t.Fatal("expected X-Request-ID header")
	}
}

func TestHealthDemandsConsoleLoginWithBackend(t *testing.T) {
	resources, _ := resourceProfile("adaptive", runtime.NumCPU())
	handler := newHandlerWithBackend(testAssets(), resources, "", &backendApp{})
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	var body healthResponse
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !body.StaffConsoleLogin {
		t.Fatal("expected the console sign-in gate to be mandatory when the backend exists")
	}
}

func TestBindBackendListenerFallsBackWhenAStrangerHoldsThePort(t *testing.T) {
	squatter, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("squat a port: %v", err)
	}
	defer squatter.Close()

	cfg := config{backendListen: squatter.Addr().String()}

	listener, err := bindBackendListener(&cfg, log.New(io.Discard, "", 0))
	if err != nil {
		t.Fatalf("expected a fallback port, got: %v", err)
	}
	defer listener.Close()

	if cfg.backendListen == squatter.Addr().String() {
		t.Fatal("expected the config to move off the squatted address")
	}
	if listener.Addr().String() != cfg.backendListen {
		t.Fatalf("config says %s but the listener is on %s", cfg.backendListen, listener.Addr().String())
	}
}

func TestBindBackendListenerNamesOurOwnRunningInstance(t *testing.T) {
	running := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": appName})
	}))
	defer running.Close()

	cfg := config{backendListen: strings.TrimPrefix(running.URL, "http://")}

	if _, err := bindBackendListener(&cfg, log.New(io.Discard, "", 0)); err == nil {
		t.Fatal("expected the already-running refusal")
	} else if !strings.Contains(err.Error(), "already running") {
		t.Fatalf("unexpected error wording: %v", err)
	}
}

func TestSPAFallback(t *testing.T) {
	handler := newHandler(testAssets())
	request := httptest.NewRequest(http.MethodGet, "/settings/profile", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	if !strings.Contains(response.Body.String(), "NPL test UI") {
		t.Fatalf("expected SPA index, got %q", response.Body.String())
	}
}

func TestNetworkQualityClassification(t *testing.T) {
	tests := []struct {
		name      string
		latencyMS int
		jitterMS  int
		successes int
		wantLevel int
		wantBars  int
	}{
		{name: "excellent", latencyMS: 24, successes: 3, wantLevel: 10, wantBars: 5},
		{name: "stable", latencyMS: 180, successes: 3, wantLevel: 6, wantBars: 3},
		{name: "jitter penalty", latencyMS: 75, jitterMS: 150, successes: 3, wantLevel: 6, wantBars: 3},
		{name: "partial reliability cap", latencyMS: 24, successes: 2, wantLevel: 6, wantBars: 3},
		{name: "critical reliability cap", latencyMS: 24, successes: 1, wantLevel: 3, wantBars: 2},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			level := classifyNetworkQuality(test.latencyMS, test.jitterMS, test.successes, 3)
			if level != test.wantLevel {
				t.Fatalf("expected level %d, got %d", test.wantLevel, level)
			}
			if bars := signalBars(level); bars != test.wantBars {
				t.Fatalf("expected %d bars, got %d", test.wantBars, bars)
			}
		})
	}
}

func TestNetworkQualityCopy(t *testing.T) {
	for level := 1; level <= 10; level++ {
		grade, summary := networkQualityCopy(level)
		if grade == "" || summary == "" {
			t.Fatalf("level %d has incomplete operator copy", level)
		}
	}
	if bars := signalBars(0); bars != 0 {
		t.Fatalf("offline signal should have no bars, got %d", bars)
	}
}

func testAssets() fs.FS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html><body>NPL test UI</body></html>")},
	}
}

func TestLicenseStatusStartsUnactivated(t *testing.T) {
	t.Setenv("NPL_INTERNAL_DATA_DIR", t.TempDir())

	handler := newHandler(testAssets())
	request := httptest.NewRequest(http.MethodGet, "/api/license/status", nil)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", response.Code)
	}
	var body licenseStatus
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Activated || body.Valid {
		t.Fatalf("a fresh install must not be activated: %+v", body)
	}
	if body.DeviceID == "" || !strings.HasPrefix(body.DeviceID, "NPLI-") {
		t.Fatalf("expected a generated NPLI- device id, got %q", body.DeviceID)
	}
	if body.Message == "" {
		t.Fatal("expected guidance telling the operator to enter a CD-Key")
	}
}

func TestLicenseActivateRejectsEmptyKey(t *testing.T) {
	t.Setenv("NPL_INTERNAL_DATA_DIR", t.TempDir())

	handler := newHandler(testAssets())
	request := httptest.NewRequest(http.MethodPost, "/api/license/activate", strings.NewReader(`{"key":"  "}`))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for a blank key, got %d", response.Code)
	}
}

func TestMaskKeyHidesTheMiddleGroups(t *testing.T) {
	if got := maskKey("NPL-ABCD-EFGH-JKLM"); got != "NPL-••••-••••-JKLM" {
		t.Fatalf("unexpected mask: %s", got)
	}
	if got := maskKey(""); got != "" {
		t.Fatalf("expected empty mask for empty key, got %q", got)
	}
}
