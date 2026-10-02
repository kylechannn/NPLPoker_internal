package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const reviewMarkerName = "npl-app-review-profile.json"

type reviewProfileMarker struct {
	ProfileID string `json:"profile_id"`
}

func reviewProfileEnabled() bool { return os.Getenv("NPL_INTERNAL_REVIEW_PROFILE") == "1" }

// A review launch must use a separately prepared portable copy. Merely setting
// an environment variable beside a venue installation must never boot its DB.
func validateReviewProfile(root string, enabled bool) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, reviewMarkerName))
	if !enabled {
		if err == nil {
			return "", errors.New("this is an App Review copy; use Start-AppReview.ps1 to open it")
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		return "", nil
	}
	if err != nil {
		return "", errors.New("App Review requires its own prepared portable copy; run scripts/prepare-app-review.ps1 first")
	}
	var marker reviewProfileMarker
	if json.Unmarshal(data, &marker) != nil || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(marker.ProfileID) {
		return "", errors.New("invalid App Review profile marker")
	}
	return marker.ProfileID, nil
}

func prepareReviewProfile(cfg *config) error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	root := filepath.Dir(executable)
	profileID, err := validateReviewProfile(root, reviewProfileEnabled())
	if err != nil || profileID == "" {
		return err
	}
	for _, relative := range []string{"app/npl_internal/artisan", ".tools/php/php.exe"} {
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative))); err != nil || info.IsDir() {
			return fmt.Errorf("incomplete App Review portable copy: %s is missing", relative)
		}
	}
	if err := os.Setenv("NPL_INTERNAL_DATA_DIR", filepath.Join(root, "review-runtime", "license")); err != nil {
		return err
	}
	if err := os.Setenv("NPL_INTERNAL_REVIEW_ID", profileID); err != nil {
		return err
	}
	if err := os.Setenv("NPL_INTERNAL_REVIEW_ROOT", root); err != nil {
		return err
	}
	// No venue Caddy gateway, shared ports, or external staff pairing listener.
	cfg.direct = true
	cfg.backendListen = "127.0.0.1:8988"
	cfg.staffPublicURL = ""
	return nil
}

func desktopProfileTitle(title string) string {
	if reviewProfileEnabled() {
		return title + " - APP REVIEW TEST"
	}
	return title
}

func desktopProfileDataPath() string {
	if reviewProfileEnabled() {
		return filepath.Join(os.Getenv("NPL_INTERNAL_REVIEW_ROOT"), "review-runtime", "WebView2")
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "NPLPoker", "OperationalSystem", "WebView2")
}

// Review children must not inherit a venue DB, cache backend, mail transport,
// framework-cache path, or credential through the launching shell.
func reviewBackendEnvironment(base []string, appDir string) []string {
	if !reviewProfileEnabled() {
		return base
	}
	blocked := []string{"APP_", "DB_", "DATABASE_URL", "CACHE_", "SESSION_", "QUEUE_", "REDIS_", "MAIL_", "AWS_", "FILESYSTEM_", "BROADCAST_", "VIEW_", "NPL_MEDIA_PATH", "LARAVEL_", "PHPRC", "PHP_INI_SCAN_DIR"}
	filtered := make([]string, 0, len(base))
	for _, entry := range base {
		key := strings.ToUpper(strings.SplitN(entry, "=", 2)[0])
		keep := true
		for _, prefix := range blocked {
			if strings.HasPrefix(key, prefix) {
				keep = false
				break
			}
		}
		if keep {
			filtered = append(filtered, entry)
		}
	}
	return append(filtered,
		"APP_ENV=production", "APP_DEBUG=false", "DB_CONNECTION=sqlite",
		"DB_DATABASE="+filepath.Join(appDir, "database", "database.sqlite"),
		"CACHE_STORE=database", "SESSION_DRIVER=database", "QUEUE_CONNECTION=database",
		"FILESYSTEM_DISK=local", "MAIL_MAILER=log", "BROADCAST_CONNECTION=log")
}
