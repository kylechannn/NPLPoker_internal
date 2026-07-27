package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	staffChallengeTTL = 3 * time.Minute
	staffSessionTTL   = 8 * time.Hour
	staffMaxAttempts  = 5
)

type staffIdentity struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"`
	Initials string `json:"initials"`
}

type staffChallenge struct {
	ID              string
	TokenHash       [32]byte
	PairingCodeHash [32]byte
	CreatedAt       time.Time
	ExpiresAt       time.Time
	Status          string
	Attempts        int
	Staff           *staffIdentity
}

type staffSession struct {
	TokenHash [32]byte
	Staff     staffIdentity
	ExpiresAt time.Time
}

type staffChallengeCreateResponse struct {
	ID                 string `json:"id"`
	LoginURL           string `json:"login_url"`
	PairingCode        string `json:"pairing_code"`
	Status             string `json:"status"`
	ExpiresAt          string `json:"expires_at"`
	SecondsRemaining   int    `json:"seconds_remaining"`
	AccessCodeRequired bool   `json:"access_code_required"`
}

type staffChallengeStatusResponse struct {
	ID               string         `json:"id"`
	Status           string         `json:"status"`
	ExpiresAt        string         `json:"expires_at"`
	SecondsRemaining int            `json:"seconds_remaining"`
	Staff            *staffIdentity `json:"staff,omitempty"`
}

type staffLoginManager struct {
	mu            sync.Mutex
	publicBaseURL string
	now           func() time.Time
	challenges    map[string]*staffChallenge
	sessions      map[string]*staffSession
}

func newStaffLoginManager(publicBaseURL string) *staffLoginManager {
	return &staffLoginManager{
		publicBaseURL: strings.TrimRight(strings.TrimSpace(publicBaseURL), "/"),
		now:           time.Now,
		challenges:    make(map[string]*staffChallenge),
		sessions:      make(map[string]*staffSession),
	}
}

func (manager *staffLoginManager) register(mux *http.ServeMux) {
	mux.Handle("POST /api/staff-login/challenges", requireGateway("desktop", http.HandlerFunc(manager.createChallenge)))
	mux.Handle("GET /api/staff-login/challenges/{id}", requireGateway("desktop", http.HandlerFunc(manager.challengeStatus)))
	mux.Handle("DELETE /api/staff-login/challenges/{id}", requireGateway("desktop", http.HandlerFunc(manager.cancelChallenge)))
	mux.Handle("GET /staff-login", requireGateway("staff", http.HandlerFunc(manager.mobileLoginPage)))
	mux.Handle("POST /staff-login/approve", requireGateway("staff", http.HandlerFunc(manager.approveMobileLogin)))
	mux.Handle("GET /api/staff-login/session", requireGateway("staff", http.HandlerFunc(manager.mobileSession)))
}

func (manager *staffLoginManager) createChallenge(w http.ResponseWriter, _ *http.Request) {
	if manager.publicBaseURL == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "No private LAN address is available. Connect this computer to the venue network, then try again.",
		})
		return
	}

	token, err := randomURLToken(32)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create a secure login token"})
		return
	}
	id, err := randomURLToken(12)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create a secure challenge"})
		return
	}
	pairingCode, err := randomPairingCode()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create a pairing code"})
		return
	}

	now := manager.now().UTC()
	challenge := &staffChallenge{
		ID:              id,
		TokenHash:       sha256.Sum256([]byte(token)),
		PairingCodeHash: sha256.Sum256([]byte(pairingCode)),
		CreatedAt:       now,
		ExpiresAt:       now.Add(staffChallengeTTL),
		Status:          "waiting",
	}

	manager.mu.Lock()
	manager.cleanupLocked(now)
	manager.challenges[id] = challenge
	manager.mu.Unlock()

	loginURL := manager.publicBaseURL + "/staff-login?t=" + url.QueryEscape(token)
	writeJSON(w, http.StatusCreated, staffChallengeCreateResponse{
		ID:                 id,
		LoginURL:           loginURL,
		PairingCode:        pairingCode,
		Status:             challenge.Status,
		ExpiresAt:          challenge.ExpiresAt.Format(time.RFC3339),
		SecondsRemaining:   int(staffChallengeTTL / time.Second),
		AccessCodeRequired: true,
	})
}

func (manager *staffLoginManager) challengeStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	now := manager.now().UTC()

	manager.mu.Lock()
	defer manager.mu.Unlock()
	challenge, ok := manager.challenges[id]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "login request was not found"})
		return
	}
	manager.expireChallengeLocked(challenge, now)
	writeJSON(w, http.StatusOK, staffChallengeStatusResponse{
		ID:               challenge.ID,
		Status:           challenge.Status,
		ExpiresAt:        challenge.ExpiresAt.Format(time.RFC3339),
		SecondsRemaining: secondsRemaining(challenge.ExpiresAt, now),
		Staff:            challenge.Staff,
	})
}

func (manager *staffLoginManager) cancelChallenge(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	manager.mu.Lock()
	defer manager.mu.Unlock()
	challenge, ok := manager.challenges[id]
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "login request was not found"})
		return
	}
	if challenge.Status != "approved" && challenge.Status != "expired" {
		challenge.Status = "cancelled"
	}
	w.WriteHeader(http.StatusNoContent)
}

func (manager *staffLoginManager) mobileLoginPage(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("t"))
	challenge, state := manager.challengeForToken(token, true)
	if challenge == nil {
		manager.renderMobilePage(w, http.StatusGone, mobileLoginView{
			State:   state,
			Heading: "This staff link is unavailable",
			Message: staffStateMessage(state),
		})
		return
	}

	manager.renderMobilePage(w, http.StatusOK, mobileLoginView{
		State:            challenge.Status,
		Heading:          "Staff access",
		Message:          "Confirm your identity to start a secure NPL staff session.",
		Token:            token,
		SecondsRemaining: secondsRemaining(challenge.ExpiresAt, manager.now().UTC()),
		Roles:            staffRoles(),
	})
}

func (manager *staffLoginManager) approveMobileLogin(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		manager.renderMobileError(w, http.StatusBadRequest, "The sign-in form could not be read.")
		return
	}

	token := strings.TrimSpace(r.FormValue("token"))
	challenge, state := manager.challengeForToken(token, false)
	if challenge == nil {
		manager.renderMobileError(w, http.StatusGone, staffStateMessage(state))
		return
	}

	identity, err := validateStaffIdentity(
		r.FormValue("staff_id"),
		r.FormValue("staff_name"),
		r.FormValue("staff_role"),
	)
	if err != nil {
		manager.renderMobileFormError(w, token, challenge, err.Error())
		return
	}

	pairingHash := sha256.Sum256([]byte(strings.TrimSpace(r.FormValue("pairing_code"))))

	manager.mu.Lock()
	now := manager.now().UTC()
	manager.expireChallengeLocked(challenge, now)
	if challenge.Status != "waiting" && challenge.Status != "scanned" {
		state = challenge.Status
		manager.mu.Unlock()
		manager.renderMobileError(w, http.StatusGone, staffStateMessage(state))
		return
	}
	if subtle.ConstantTimeCompare(pairingHash[:], challenge.PairingCodeHash[:]) != 1 {
		challenge.Attempts++
		if challenge.Attempts >= staffMaxAttempts {
			challenge.Status = "locked"
		}
		state = challenge.Status
		manager.mu.Unlock()
		if state == "locked" {
			manager.renderMobileError(w, http.StatusTooManyRequests, staffStateMessage(state))
			return
		}
		manager.renderMobileFormError(w, token, challenge, "The 6-digit pairing code does not match NPL OS.")
		return
	}

	sessionToken, tokenErr := randomURLToken(32)
	if tokenErr != nil {
		manager.mu.Unlock()
		manager.renderMobileError(w, http.StatusInternalServerError, "A secure staff session could not be created.")
		return
	}
	sessionHash := sha256.Sum256([]byte(sessionToken))
	challenge.Status = "approved"
	challenge.Staff = &identity
	manager.sessions[base64.RawURLEncoding.EncodeToString(sessionHash[:])] = &staffSession{
		TokenHash: sessionHash,
		Staff:     identity,
		ExpiresAt: now.Add(staffSessionTTL),
	}
	manager.mu.Unlock()

	http.SetCookie(w, &http.Cookie{
		Name:     "npl_staff_session",
		Value:    sessionToken,
		Path:     "/",
		MaxAge:   int(staffSessionTTL / time.Second),
		HttpOnly: true,
		Secure:   strings.HasPrefix(manager.publicBaseURL, "https://"),
		SameSite: http.SameSiteStrictMode,
	})
	manager.renderMobilePage(w, http.StatusOK, mobileLoginView{
		State:    "approved",
		Heading:  "Staff sign-in approved",
		Message:  fmt.Sprintf("Welcome, %s. Your secure venue session is active.", identity.Name),
		Approved: true,
		Staff:    &identity,
	})
}

func (manager *staffLoginManager) mobileSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("npl_staff_session")
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"authenticated": false})
		return
	}
	hash := sha256.Sum256([]byte(cookie.Value))
	key := base64.RawURLEncoding.EncodeToString(hash[:])
	now := manager.now().UTC()

	manager.mu.Lock()
	defer manager.mu.Unlock()
	session, ok := manager.sessions[key]
	if !ok || !session.ExpiresAt.After(now) || subtle.ConstantTimeCompare(hash[:], session.TokenHash[:]) != 1 {
		delete(manager.sessions, key)
		writeJSON(w, http.StatusUnauthorized, map[string]any{"authenticated": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"staff":         session.Staff,
		"expires_at":    session.ExpiresAt.Format(time.RFC3339),
	})
}

func (manager *staffLoginManager) challengeForToken(token string, markScanned bool) (*staffChallenge, string) {
	if token == "" {
		return nil, "invalid"
	}
	hash := sha256.Sum256([]byte(token))
	now := manager.now().UTC()

	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, challenge := range manager.challenges {
		if subtle.ConstantTimeCompare(hash[:], challenge.TokenHash[:]) != 1 {
			continue
		}
		manager.expireChallengeLocked(challenge, now)
		if challenge.Status != "waiting" && challenge.Status != "scanned" {
			return nil, challenge.Status
		}
		if markScanned {
			challenge.Status = "scanned"
		}
		return challenge, challenge.Status
	}
	return nil, "invalid"
}

func (manager *staffLoginManager) cleanupLocked(now time.Time) {
	for id, challenge := range manager.challenges {
		manager.expireChallengeLocked(challenge, now)
		if now.Sub(challenge.ExpiresAt) > 15*time.Minute {
			delete(manager.challenges, id)
		}
	}
	for key, session := range manager.sessions {
		if !session.ExpiresAt.After(now) {
			delete(manager.sessions, key)
		}
	}
}

func (manager *staffLoginManager) expireChallengeLocked(challenge *staffChallenge, now time.Time) {
	if !challenge.ExpiresAt.After(now) && (challenge.Status == "waiting" || challenge.Status == "scanned") {
		challenge.Status = "expired"
	}
}

func (manager *staffLoginManager) renderMobileFormError(
	w http.ResponseWriter,
	token string,
	challenge *staffChallenge,
	message string,
) {
	manager.renderMobilePage(w, http.StatusUnprocessableEntity, mobileLoginView{
		State:            challenge.Status,
		Heading:          "Check your details",
		Message:          message,
		Token:            token,
		SecondsRemaining: secondsRemaining(challenge.ExpiresAt, manager.now().UTC()),
		Roles:            staffRoles(),
		Error:            true,
	})
}

func (manager *staffLoginManager) renderMobileError(w http.ResponseWriter, status int, message string) {
	manager.renderMobilePage(w, status, mobileLoginView{
		State:   "error",
		Heading: "Staff sign-in unavailable",
		Message: message,
		Error:   true,
	})
}

type mobileLoginView struct {
	State            string
	Heading          string
	Message          string
	Token            string
	SecondsRemaining int
	Roles            []string
	Error            bool
	Approved         bool
	Staff            *staffIdentity
}

var mobileLoginTemplate = template.Must(template.New("staff-login").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="color-scheme" content="dark">
  <title>NPL Staff Access</title>
  <style>
    :root{color-scheme:dark;--bg:#020712;--panel:#07142b;--line:rgba(82,160,230,.24);--text:#f2f7ff;--muted:#96a9c4;--cyan:#38e5ff;--blue:#3d7bff;--gold:#f4c54c;--danger:#ff6b7d}
    *{box-sizing:border-box}html{min-height:100%;background:var(--bg)}body{min-height:100vh;margin:0;padding:max(24px,env(safe-area-inset-top)) 18px max(28px,env(safe-area-inset-bottom));display:grid;place-items:center;background:radial-gradient(circle at 50% -10%,rgba(61,123,255,.22),transparent 42%),linear-gradient(145deg,#020712,#041025);color:var(--text);font-family:Inter,"Segoe UI",Arial,sans-serif}
    main{width:min(100%,440px);border:1px solid var(--line);border-radius:24px;padding:26px;background:linear-gradient(150deg,rgba(10,28,58,.96),rgba(4,13,29,.98));box-shadow:0 24px 70px rgba(0,0,0,.4)}
    .brand{display:flex;align-items:center;gap:12px;margin-bottom:26px}.mark{display:grid;width:46px;height:46px;place-items:center;border:2px solid rgba(56,229,255,.45);border-radius:50%;background:radial-gradient(circle,rgba(61,123,255,.34),rgba(7,20,43,.4));color:#fff;font-weight:900;letter-spacing:-.08em}.brand strong{display:block;font-size:17px;letter-spacing:.08em}.brand span{display:block;margin-top:3px;color:var(--cyan);font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}
    .status{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(56,229,255,.22);border-radius:999px;padding:7px 11px;color:var(--cyan);background:rgba(56,229,255,.06);font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.status i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}
    h1{margin:18px 0 8px;font-size:30px;line-height:1.08}p{margin:0;color:var(--muted);font-size:16px;line-height:1.55}.error{color:#ffc3cb}
    form{display:grid;gap:16px;margin-top:26px}.field{display:grid;gap:7px}.field label{color:#c7d6ea;font-size:13px;font-weight:700}.field input,.field select{width:100%;min-height:52px;border:1px solid rgba(143,169,207,.28);border-radius:12px;padding:0 14px;color:var(--text);background:#061126;font:600 16px inherit;outline:none}.field input:focus,.field select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(56,229,255,.11)}.field small{color:#7187a5;font-size:12px}.code input{font-family:Consolas,monospace;font-size:24px;letter-spacing:.28em;text-align:center}
    button{min-height:56px;border:1px solid rgba(56,229,255,.42);border-radius:13px;color:#02111d;background:linear-gradient(120deg,var(--cyan),#78b8ff);font-size:15px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 12px 30px rgba(56,229,255,.13)}
    .timer{margin-top:18px;padding-top:17px;border-top:1px solid rgba(143,169,207,.15);color:#7187a5;font-size:12px;text-align:center}.approved{display:grid;place-items:center;margin:28px 0 18px}.approved span{display:grid;width:76px;height:76px;place-items:center;border:1px solid rgba(56,229,255,.45);border-radius:50%;color:#051525;background:var(--cyan);font-size:38px;font-weight:900;box-shadow:0 0 36px rgba(56,229,255,.22)}.identity{margin-top:18px;border:1px solid rgba(56,229,255,.2);border-radius:14px;padding:15px;background:rgba(56,229,255,.05);text-align:center}.identity strong{display:block;font-size:18px}.identity span{display:block;margin-top:4px;color:var(--cyan);font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
    footer{margin-top:23px;color:#5f7492;font-size:11px;line-height:1.5;text-align:center}
  </style>
</head>
<body>
  <main>
    <div class="brand"><span class="mark">NPL</span><div><strong>NPL POKER</strong><span>Operational System</span></div></div>
    <span class="status"><i></i>{{if .Approved}}Session active{{else}}Private venue gateway{{end}}</span>
    {{if .Approved}}
      <div class="approved"><span>✓</span></div>
      <h1>{{.Heading}}</h1><p>{{.Message}}</p>
      {{with .Staff}}<div class="identity"><strong>{{.Name}}</strong><span>{{.Role}} · {{.ID}}</span></div>{{end}}
    {{else}}
      <h1>{{.Heading}}</h1><p class="{{if .Error}}error{{end}}">{{.Message}}</p>
      {{if .Token}}
      <form method="post" action="/staff-login/approve" autocomplete="off">
        <input type="hidden" name="token" value="{{.Token}}">
        <div class="field"><label for="staff-name">Full name</label><input id="staff-name" name="staff_name" maxlength="50" required autocomplete="name" placeholder="Your staff name"></div>
        <div class="field"><label for="staff-id">Staff ID</label><input id="staff-id" name="staff_id" maxlength="24" required autocapitalize="characters" placeholder="e.g. NPL-2048"></div>
        <div class="field"><label for="staff-role">Operational role</label><select id="staff-role" name="staff_role" required>{{range .Roles}}<option value="{{.}}">{{.}}</option>{{end}}</select></div>
        <div class="field code"><label for="pairing-code">6-digit pairing code</label><input id="pairing-code" name="pairing_code" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" required placeholder="000000"><small>Enter the code shown beside the QR on NPL OS.</small></div>
        <button type="submit">Approve staff sign-in</button>
      </form>
      <div class="timer">This one-time request expires in about {{.SecondsRemaining}} seconds.</div>
      {{end}}
    {{end}}
    <footer>One-time encrypted token · Single-use pairing code · NPL private LAN only</footer>
  </main>
</body>
</html>`))

func (manager *staffLoginManager) renderMobilePage(w http.ResponseWriter, status int, view mobileLoginView) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.WriteHeader(status)
	_ = mobileLoginTemplate.Execute(w, view)
}

func validateStaffIdentity(id, name, role string) (staffIdentity, error) {
	id = strings.ToUpper(strings.TrimSpace(id))
	name = strings.Join(strings.Fields(strings.TrimSpace(name)), " ")
	role = strings.TrimSpace(role)

	if utf8.RuneCountInString(name) < 2 || utf8.RuneCountInString(name) > 50 {
		return staffIdentity{}, errors.New("Enter the staff member's full name.")
	}
	if len(id) < 3 || len(id) > 24 {
		return staffIdentity{}, errors.New("Enter a valid staff ID.")
	}
	for _, character := range id {
		if (character < 'A' || character > 'Z') &&
			(character < '0' || character > '9') &&
			character != '-' && character != '_' && character != '.' {
			return staffIdentity{}, errors.New("Staff ID may use letters, numbers, hyphens, underscores, and dots.")
		}
	}
	allowedRole := false
	for _, candidate := range staffRoles() {
		if role == candidate {
			allowedRole = true
			break
		}
	}
	if !allowedRole {
		return staffIdentity{}, errors.New("Choose a valid operational role.")
	}
	return staffIdentity{
		ID:       id,
		Name:     name,
		Role:     role,
		Initials: staffInitials(name),
	}, nil
}

func staffRoles() []string {
	roles := []string{"Dealer", "Floor Manager", "Operations", "Registration", "Tournament Director"}
	sort.Strings(roles)
	return roles
}

func staffInitials(name string) string {
	parts := strings.Fields(name)
	if len(parts) == 0 {
		return "NPL"
	}
	first := []rune(parts[0])
	if len(parts) == 1 {
		if len(first) > 1 {
			return strings.ToUpper(string(first[:2]))
		}
		return strings.ToUpper(string(first))
	}
	last := []rune(parts[len(parts)-1])
	return strings.ToUpper(string(first[0]) + string(last[0]))
}

func randomURLToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func randomPairingCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", value.Int64()), nil
}

func secondsRemaining(expiresAt, now time.Time) int {
	if !expiresAt.After(now) {
		return 0
	}
	return int(expiresAt.Sub(now).Round(time.Second) / time.Second)
}

func staffStateMessage(state string) string {
	switch state {
	case "expired":
		return "This one-time QR request has expired. Ask the operator to generate a new one."
	case "approved":
		return "This one-time staff sign-in has already been approved."
	case "cancelled":
		return "The operator cancelled this staff sign-in request."
	case "locked":
		return "This request was locked after too many incorrect pairing codes. Ask the operator for a new QR."
	default:
		return "This QR code is invalid or is no longer active."
	}
}

func requireGateway(expected string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-NPL-Gateway") != expected {
			http.NotFound(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func preferredLANIPv4() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	bestScore := -1
	bestIP := ""
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 ||
			networkInterface.Flags&net.FlagLoopback != 0 ||
			isVirtualStaffInterface(networkInterface.Name) {
			continue
		}
		addresses, _ := networkInterface.Addrs()
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err != nil || !usableLANIPv4(ip) {
				continue
			}
			score := staffInterfaceScore(networkInterface.Name, ip)
			if score > bestScore {
				bestScore = score
				bestIP = ip.String()
			}
		}
	}
	if bestIP != "" {
		return bestIP
	}

	if connection, err := net.Dial("udp4", "8.8.8.8:80"); err == nil {
		defer connection.Close()
		if address, ok := connection.LocalAddr().(*net.UDPAddr); ok && usableLANIPv4(address.IP) {
			return address.IP.String()
		}
	}
	return ""
}

func usableLANIPv4(ip net.IP) bool {
	ip = ip.To4()
	return ip != nil && !ip.IsLoopback() && !ip.IsUnspecified() && !ip.IsLinkLocalUnicast()
}

func staffInterfaceScore(name string, ip net.IP) int {
	ip = ip.To4()
	if ip == nil {
		return -1
	}
	score := 20
	if ip.IsPrivate() {
		score = 40
	} else if ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
		score = 30
	}
	lowerName := strings.ToLower(name)
	for _, preferred := range []string{"wi-fi", "wifi", "wireless", "ethernet"} {
		if strings.Contains(lowerName, preferred) {
			score += 100
			break
		}
	}
	return score
}

func isVirtualStaffInterface(name string) bool {
	lowerName := strings.ToLower(name)
	for _, marker := range []string{
		"vpn", "vethernet", "virtualbox", "vmware", "npcap", "hamachi",
		"zerotier", "tailscale", "bridge", "bluetooth", "loopback",
	} {
		if strings.Contains(lowerName, marker) {
			return true
		}
	}
	return false
}

func staffPublicBaseURL(cfg config) string {
	if cfg.direct {
		return ""
	}
	if cfg.staffPublicURL != "" {
		return cfg.staffPublicURL
	}
	host, port, err := net.SplitHostPort(cfg.staffListen)
	if err != nil {
		return ""
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = preferredLANIPv4()
	}
	if host == "" || strings.EqualFold(host, "localhost") {
		return ""
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return ""
	}
	return "http://" + net.JoinHostPort(host, port)
}
