package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// CD-Key gate for this install.
//
// The key is ~60 bits of server-side entropy with no offline-derivable
// structure, so activation is online: we post the key plus a device id to
// the NPL cloud and store the lease that comes back. Unlike the EdgeHost
// original this replaces, the lease has a hard expiry we actually enforce —
// once it lapses the app locks until a successful re-check, so a revoked
// key stops working instead of running forever.
const (
	licenseFileName  = "license.json"
	licenseCheckEach = 6 * time.Hour
)

type licenseLease struct {
	UUID       string `json:"uuid"`
	Label      string `json:"label"`
	Product    string `json:"product"`
	VenueID    *int   `json:"venue_id"`
	VenueName  string `json:"venue_name"`
	Status     string `json:"status"`
	ExpiresAt  string `json:"expires_at"`
	LeaseUntil string `json:"lease_until"`
	DeviceID   string `json:"device_id"`
	DeviceLbl  string `json:"device_label"`
}

// versionPolicy is the cloud's verdict on this build, carried back on every
// licence activate/check. It is persisted with the lease so a desk that was
// told to update still knows after an offline restart. The gate is the AND
// of two voices: the cloud's stored update_required (the authority — it
// carries the OS_VERSION_LOCK kill switch and block_unknown policy) and a
// local recompute against the RUNNING build, so installing an update clears
// the gate immediately instead of waiting for the next successful check.
type versionPolicy struct {
	CurrentVersion         string `json:"current_version"`
	LatestVersion          string `json:"latest_version"`
	MinimumRequiredVersion string `json:"minimum_required_version"`
	UpdateRequired         bool   `json:"update_required"`
	Message                string `json:"message"`
	DownloadURL            string `json:"download_url"`
	Reason                 string `json:"reason"`
}

// stored is what we persist beside the executable's data directory.
type stored struct {
	Key       string         `json:"key"`
	DeviceID  string         `json:"device_id"`
	Lease     *licenseLease  `json:"lease"`
	Policy    *versionPolicy `json:"version_policy,omitempty"`
	CheckedAt string         `json:"checked_at"`
}

type licenseStatus struct {
	Activated  bool          `json:"activated"`
	Valid      bool          `json:"valid"`
	MaskedKey  string        `json:"masked_key"`
	DeviceID   string        `json:"device_id"`
	Lease      *licenseLease `json:"lease"`
	LeaseValid bool          `json:"lease_valid"`
	Message    string        `json:"message"`
	CloudBase  string        `json:"cloud_base"`
}

type licenseManager struct {
	mu        sync.Mutex
	path      string
	cloudBase string
	client    *http.Client
	state     stored
}

func newLicenseManager() *licenseManager {
	manager := &licenseManager{
		path:      licenseFilePath(),
		cloudBase: strings.TrimRight(envOrDefault("NPL_CLOUD_BASE", "https://api.nplpokerclub.com.au"), "/"),
		client:    &http.Client{Timeout: 8 * time.Second},
	}
	manager.load()
	return manager
}

func licenseFilePath() string {
	if configured := strings.TrimSpace(os.Getenv("NPL_INTERNAL_DATA_DIR")); configured != "" {
		return filepath.Join(configured, licenseFileName)
	}

	base, err := os.UserConfigDir()
	if err != nil || base == "" {
		if home, homeErr := os.UserHomeDir(); homeErr == nil {
			base = home
		} else {
			base = "."
		}
	}
	return filepath.Join(base, "NPLPokerInternal", licenseFileName)
}

func (m *licenseManager) load() {
	data, err := os.ReadFile(m.path)
	if err != nil {
		return
	}
	var state stored
	if err := json.Unmarshal(data, &state); err == nil {
		m.state = state
	}
}

func (m *licenseManager) save() error {
	if err := os.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return fmt.Errorf("create data directory: %w", err)
	}
	payload, err := json.MarshalIndent(m.state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.path, payload, 0o600)
}

// deviceID is stable for this machine+user so reinstalls reuse the slot.
func (m *licenseManager) deviceID() string {
	if m.state.DeviceID != "" {
		return m.state.DeviceID
	}

	host, _ := os.Hostname()
	configDir, _ := os.UserConfigDir()
	sum := sha1.Sum([]byte(host + "|" + configDir + "|" + runtime.GOOS))
	m.state.DeviceID = "NPLI-" + strings.ToUpper(hex.EncodeToString(sum[:])[:12])
	return m.state.DeviceID
}

func (m *licenseManager) leaseValid() bool {
	if m.state.Lease == nil || m.state.Lease.LeaseUntil == "" {
		return false
	}
	until, err := time.Parse(time.RFC3339, m.state.Lease.LeaseUntil)
	if err != nil {
		return false
	}
	return time.Now().Before(until)
}

func (m *licenseManager) status() licenseStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func (m *licenseManager) statusLocked() licenseStatus {
	activated := m.state.Key != "" && m.state.Lease != nil
	valid := activated && m.leaseValid()

	message := ""
	switch {
	case !activated:
		message = "Enter the CD-Key supplied by NPL to activate this install."
	case !valid:
		message = "This licence lease has expired. Reconnect to refresh it."
	}

	return licenseStatus{
		Activated:  activated,
		Valid:      valid,
		MaskedKey:  maskKey(m.state.Key),
		DeviceID:   m.deviceID(),
		Lease:      m.state.Lease,
		LeaseValid: valid,
		Message:    message,
		CloudBase:  m.cloudBase,
	}
}

func (m *licenseManager) activate(key string) (licenseStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	key = strings.ToUpper(strings.TrimSpace(key))
	if key == "" {
		return m.statusLocked(), errors.New("enter your CD-Key")
	}

	lease, policy, err := m.post("/api/v1/licenses/activate", key)
	if err != nil {
		return m.statusLocked(), err
	}

	m.state.Key = key
	m.state.Lease = lease
	if policy != nil {
		m.state.Policy = policy
	}
	m.state.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	if err := m.save(); err != nil {
		return m.statusLocked(), err
	}
	return m.statusLocked(), nil
}

func (m *licenseManager) check() (licenseStatus, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state.Key == "" {
		return m.statusLocked(), errors.New("this install is not activated")
	}

	lease, policy, err := m.post("/api/v1/licenses/check", m.state.Key)
	if err != nil {
		// Keep running on the existing lease if it has not lapsed — a flaky
		// venue connection must not stop the desk mid-session.
		return m.statusLocked(), err
	}

	m.state.Lease = lease
	if policy != nil {
		m.state.Policy = policy
	}
	m.state.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	if err := m.save(); err != nil {
		return m.statusLocked(), err
	}
	return m.statusLocked(), nil
}

func (m *licenseManager) post(path, key string) (*licenseLease, *versionPolicy, error) {
	hostname, _ := os.Hostname()
	body, err := json.Marshal(map[string]string{
		"key":          key,
		"device_id":    m.deviceID(),
		"device_label": hostname,
		"app_version":  version,
		"os":           runtime.GOOS + " " + runtime.GOARCH,
	})
	if err != nil {
		return nil, nil, err
	}

	request, err := http.NewRequest(http.MethodPost, m.cloudBase+path, bytes.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	response, err := m.client.Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("could not reach the NPL licence server: %w", err)
	}
	defer func() { _ = response.Body.Close() }()

	var envelope struct {
		OK   bool `json:"ok"`
		Data struct {
			License licenseLease   `json:"license"`
			Policy  *versionPolicy `json:"version_policy"`
		} `json:"data"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		return nil, nil, fmt.Errorf("unexpected response from the licence server (%d)", response.StatusCode)
	}

	if !envelope.OK {
		if envelope.Error.Message != "" {
			return nil, nil, errors.New(envelope.Error.Message)
		}
		return nil, nil, fmt.Errorf("licence request refused (%d)", response.StatusCode)
	}

	lease := envelope.Data.License
	return &lease, envelope.Data.Policy, nil
}

// versionPolicy returns a copy of the last policy the cloud sent, or nil if
// this install has never completed an activate/check.
func (m *licenseManager) versionPolicy() *versionPolicy {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state.Policy == nil {
		return nil
	}
	policy := *m.state.Policy
	return &policy
}

// updateRequiredFor decides the gate for the given running build. The cloud
// is the authority — its stored update_required verdict already folds in the
// OS_VERSION_LOCK kill switch, so a stood-down cloud can never be overruled
// locally. The local version compare only ever CLEARS the gate: a desk that
// just installed the update passes immediately, without waiting for the
// next successful check to refresh the cached policy. Builds that cannot
// state a comparable version ("dev", unstamped runs) fail open, matching
// the cloud's own gate.
func (p *versionPolicy) updateRequiredFor(current string) bool {
	if p == nil || !p.UpdateRequired {
		return false
	}
	minimum := normalizeVersion(p.MinimumRequiredVersion)
	if minimum == "" {
		return false
	}
	current = normalizeVersion(current)
	if !comparableVersion(current) {
		return false
	}
	return compareVersions(current, minimum) < 0
}

func normalizeVersion(value string) string {
	return strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(value), "vV"))
}

func comparableVersion(value string) bool {
	return value != "" && value[0] >= '0' && value[0] <= '9'
}

// compareVersions compares dotted release strings segment by segment,
// numerically, ignoring any non-numeric tail ("1.3.0-rc1" counts as 1.3.0).
func compareVersions(a, b string) int {
	left, right := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(left) || i < len(right); i++ {
		var leftValue, rightValue int
		if i < len(left) {
			leftValue = leadingInt(left[i])
		}
		if i < len(right) {
			rightValue = leadingInt(right[i])
		}
		if leftValue != rightValue {
			if leftValue < rightValue {
				return -1
			}
			return 1
		}
	}
	return 0
}

func leadingInt(segment string) int {
	value := 0
	for _, r := range segment {
		if r < '0' || r > '9' {
			break
		}
		value = value*10 + int(r-'0')
		if value > 1_000_000 {
			break
		}
	}
	return value
}

func maskKey(key string) string {
	if key == "" {
		return ""
	}
	parts := strings.Split(key, "-")
	if len(parts) < 2 {
		return key[:min(4, len(key))] + "••••"
	}
	for i := 1; i < len(parts)-1; i++ {
		parts[i] = strings.Repeat("•", len(parts[i]))
	}
	return strings.Join(parts, "-")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
