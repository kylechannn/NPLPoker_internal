package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReviewProfileRequiresSeparateMarkedCopy(t *testing.T) {
	root := t.TempDir()
	if _, err := validateReviewProfile(root, true); err == nil {
		t.Fatal("unmarked venue copy accepted for review")
	}
	if _, err := validateReviewProfile(root, false); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, reviewMarkerName)
	if err := os.WriteFile(path, []byte(`{"profile_id":"1234567890abcdef1234567890abcdef"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateReviewProfile(root, false); err == nil {
		t.Fatal("review copy accepted for normal startup")
	}
	if id, err := validateReviewProfile(root, true); err != nil || len(id) != 32 {
		t.Fatalf("valid review marker rejected: %q %v", id, err)
	}
	if err := os.WriteFile(path, []byte(`{"profile_id":"../../venue"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateReviewProfile(root, true); err == nil {
		t.Fatal("invalid profile id accepted")
	}
}

func TestReviewRuntimeIsolatesBrowserAndDevice(t *testing.T) {
	t.Setenv("NPL_INTERNAL_REVIEW_PROFILE", "")
	normalDevice := (&licenseManager{}).deviceID()
	normalBrowser := desktopProfileDataPath()
	t.Setenv("NPL_INTERNAL_REVIEW_PROFILE", "1")
	t.Setenv("NPL_INTERNAL_REVIEW_ID", "review-a")
	t.Setenv("NPL_INTERNAL_REVIEW_ROOT", t.TempDir())
	first := (&licenseManager{}).deviceID()
	if first == normalDevice || desktopProfileDataPath() == normalBrowser {
		t.Fatal("review shares normal identity or browser storage")
	}
	if first != (&licenseManager{}).deviceID() {
		t.Fatal("review identity is not stable")
	}
	t.Setenv("NPL_INTERNAL_REVIEW_ID", "review-b")
	if first == (&licenseManager{}).deviceID() {
		t.Fatal("independent review copies share a device identity")
	}
}

func TestReviewBackendDoesNotInheritVenueConnections(t *testing.T) {
	t.Setenv("NPL_INTERNAL_REVIEW_PROFILE", "1")
	base := []string{"PATH=bin", "DB_URL=mysql://venue", "DB_DATABASE=venue.sqlite", "CACHE_DB_DATABASE=venue.sqlite", "APP_CONFIG_CACHE=venue-config.php", "MAIL_PASSWORD=secret", "NPL_MEDIA_PATH=venue-media", "LARAVEL_STORAGE_PATH=venue-storage", "PHPRC=venue-php.ini", "PHP_INI_SCAN_DIR=venue-php-extra", "NPL_HOST_BRIDGE=http://127.0.0.1:8988"}
	result := strings.Join(reviewBackendEnvironment(base, "review-app"), "\n")
	for _, forbidden := range []string{"venue.sqlite", "mysql://venue", "venue-config.php", "MAIL_PASSWORD", "venue-media", "venue-storage", "venue-php"} {
		if strings.Contains(result, forbidden) {
			t.Fatalf("inherited %s", forbidden)
		}
	}
	for _, required := range []string{"DB_CONNECTION=sqlite", "CACHE_STORE=database", "MAIL_MAILER=log", "PATH=bin", "NPL_HOST_BRIDGE="} {
		if !strings.Contains(result, required) {
			t.Fatalf("missing %s", required)
		}
	}
}

func TestLicenseRejectsCrossProfileLeaseBeforePersisting(t *testing.T) {
	for _, review := range []bool{false, true} {
		t.Run(map[bool]string{false: "venue", true: "review"}[review], func(t *testing.T) {
			t.Setenv("NPL_INTERNAL_REVIEW_PROFILE", map[bool]string{false: "", true: "1"}[review])
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if payload["review_profile"] != review {
					t.Errorf("wrong review_profile: %v", payload["review_profile"])
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "data": map[string]any{"license": licenseLease{IsAppReview: !review, LeaseUntil: time.Now().Add(time.Hour).Format(time.RFC3339)}}})
			}))
			defer server.Close()
			manager := &licenseManager{path: filepath.Join(t.TempDir(), "license.json"), cloudBase: server.URL, client: server.Client()}
			if _, err := manager.activate("TEST-KEY"); err == nil {
				t.Fatal("cross-profile lease accepted")
			}
			if manager.state.Key != "" {
				t.Fatal("rejected key persisted")
			}
			manager.state.Lease = &licenseLease{IsAppReview: !review, LeaseUntil: time.Now().Add(time.Hour).Format(time.RFC3339)}
			if manager.leaseValid() {
				t.Fatal("stored cross-profile lease remained valid")
			}
		})
	}
}
