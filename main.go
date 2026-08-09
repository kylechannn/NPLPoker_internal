package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

const appName = "NPL Poker Internal"

var version = "dev"

// uiAssets is built by Vite before the Go binary is compiled.
//
//go:embed ui/dist
var uiAssets embed.FS

type healthResponse struct {
	OK                bool   `json:"ok"`
	Service           string `json:"service"`
	Version           string `json:"version"`
	GoVersion         string `json:"go_version"`
	ResourceProfile   string `json:"resource_profile"`
	GoMaxProcs        int    `json:"go_max_procs"`
	GoMemoryLimitMiB  int    `json:"go_memory_limit_mib"`
	NetworkCacheSecs  int    `json:"network_cache_seconds"`
	StaffLoginEnabled bool   `json:"staff_login_enabled"`
	StaffGatewayURL   string `json:"staff_gateway_url,omitempty"`
	// True when the bundled backend (and with it the mirrored staff
	// register) exists on this install: the UI must then demand a console
	// sign-in before the OS is usable. False only for -direct dev runs and
	// installs whose backend failed to start, where the console stays
	// reachable for diagnostics.
	StaffConsoleLogin bool   `json:"staff_console_login"`
	Time              string `json:"time"`
	// The cloud's minimum-version policy, recomputed against this running
	// build: when UpdateRequired is true the UI must block the console with
	// the update notice until the install is updated.
	UpdateRequired    bool   `json:"update_required"`
	UpdateMessage     string `json:"update_message,omitempty"`
	MinimumVersion    string `json:"minimum_version,omitempty"`
	LatestVersion     string `json:"latest_version,omitempty"`
	UpdateDownloadURL string `json:"update_download_url,omitempty"`
}

func main() {
	cfg, err := parseConfig()
	if err != nil {
		showNativeError(appName, err.Error())
		log.Print(err)
		os.Exit(1)
	}
	if err := run(cfg); err != nil {
		showNativeError(appName, err.Error())
		log.Print(err)
		os.Exit(1)
	}
}

func run(cfg config) error {
	restoreRuntime := applyGoRuntimeLimits(cfg.resources)
	defer restoreRuntime()

	logger := log.New(os.Stdout, "[npl-internal] ", log.LstdFlags|log.Lmsgprefix)
	logger.Printf(
		"resource profile %s: Go %d workers/%d MiB, Caddy %d workers/%d MiB, network cache %s",
		cfg.resources.profileName,
		cfg.resources.goMaxProcs,
		cfg.resources.goMemoryLimitMiB,
		cfg.resources.caddyMaxProcs,
		cfg.resources.caddyMemoryLimitMiB,
		cfg.resources.networkQualityCacheTime,
	)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	assetFS, err := fs.Sub(uiAssets, "ui/dist")
	if err != nil {
		return fmt.Errorf("load embedded UI: %w", err)
	}

	// The operational API lives in the bundled Laravel app. A failure to
	// start it is logged rather than fatal: the console, the licence gate and
	// the diagnostics all still work, which is what an operator needs in
	// order to see and fix the problem.
	backend, backendErr := startBackendApp(ctx, "http://"+cfg.backendListen)
	if backendErr != nil {
		logger.Printf("[npl-internal] operational backend unavailable: %v", backendErr)
	}
	defer backend.stop()

	server := &http.Server{
		Addr:              cfg.backendListen,
		Handler:           newHandlerWithBackend(assetFS, cfg.resources, staffPublicBaseURL(cfg), backend),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		// No write deadline: manual update legitimately runs for minutes, and
		// a WriteTimeout does not abort the handler — it just poisons the
		// connection so the eventual response comes back as a 502 EOF at the
		// gateway (and every request queued behind it dies with it). This
		// server only listens on loopback behind Caddy, so slow-client
		// protection is not its job.
		WriteTimeout:      0,
		IdleTimeout:       60 * time.Second,
	}

	listener, err := net.Listen("tcp", cfg.backendListen)
	if err != nil {
		return fmt.Errorf("listen on Go backend %s: %w", cfg.backendListen, err)
	}

	serverDone := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serverDone <- err
	}()

	var caddyCancel context.CancelFunc
	var caddyDone <-chan error
	publicAddress := cfg.backendListen

	if !cfg.direct {
		var caddyCtx context.Context
		caddyCtx, caddyCancel = context.WithCancel(ctx)
		defer caddyCancel()
		caddyDone, err = launchCaddy(caddyCtx, cfg, logger)
		if err != nil {
			_ = server.Close()
			return err
		}
		publicAddress = cfg.publicListen
	}

	publicURL := "http://" + publicAddress
	if err := waitUntilReady(ctx, publicURL+"/api/health", caddyDone, 12*time.Second); err != nil {
		if caddyCancel != nil {
			caddyCancel()
		}
		_ = server.Close()
		return err
	}

	logger.Printf("%s %s is ready at %s", appName, version, publicURL)

	var runErr error
	if cfg.headless {
		select {
		case <-ctx.Done():
			logger.Println("shutdown requested")
		case err := <-serverDone:
			runErr = err
		case err := <-caddyDone:
			if err != nil {
				runErr = fmt.Errorf("Caddy exited: %w", err)
			} else {
				runErr = errors.New("Caddy exited unexpectedly")
			}
		}
	} else {
		logger.Println("opening native operational system window")
		runErr = runDesktopWindow(publicURL)
		logger.Println("desktop window closed")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = server.Shutdown(shutdownCtx)

	if caddyCancel != nil {
		caddyCancel()
		select {
		case <-caddyDone:
		case <-time.After(3 * time.Second):
			logger.Println("timed out waiting for Caddy to stop")
		}
	}

	return runErr
}

func newHandler(assets fs.FS) http.Handler {
	resources, _ := resourceProfile("adaptive", runtime.NumCPU())
	return newHandlerWithResources(assets, resources)
}

func newHandlerWithResources(assets fs.FS, resources resourceSettings) http.Handler {
	return newHandlerWithStaffGateway(assets, resources, "")
}

func newHandlerWithStaffGateway(
	assets fs.FS,
	resources resourceSettings,
	staffGatewayURL string,
) http.Handler {
	return newHandlerWithBackend(assets, resources, staffGatewayURL, nil)
}

func newHandlerWithBackend(
	assets fs.FS,
	resources resourceSettings,
	staffGatewayURL string,
	backend *backendApp,
) http.Handler {
	mux := http.NewServeMux()
	networkMonitor := newNetworkQualityMonitor(resources.networkQualityCacheTime)
	licenses := newLicenseManager()

	// One background check at boot: the UI only re-validates every six
	// hours, and a desk the cloud has since told to update must learn that
	// on startup, not tomorrow. Best-effort — offline stays fail-open on
	// the persisted lease and policy.
	go func() {
		if licenses.status().Activated {
			_, _ = licenses.check()
		}
	}()
	staffLogin := newStaffLoginManager(staffGatewayURL)
	// Staff identities come from the cloud's register, mirrored locally by
	// Manual update — the pairing phone types a staff ID, never a name.
	staffLogin.resolveStaff = rosterResolver(backend)
	staffLogin.register(mux)

	// The silent receipt bridge: the bundled Laravel composes receipt
	// lines for buy-ins/rebuys/add-ons/jackpots and this host spools them
	// RAW to the venue's receipt printer — no dialogs, ever.
	registerReceiptPrinting(mux)

	mux.HandleFunc("GET /api/license/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, licenses.status())
	})

	mux.HandleFunc("POST /api/license/activate", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Key string `json:"key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		status, err := licenses.activate(body.Key)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "status": status})
			return
		}
		writeJSON(w, http.StatusOK, status)
	})

	mux.HandleFunc("POST /api/license/check", func(w http.ResponseWriter, _ *http.Request) {
		status, err := licenses.check()
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error(), "status": status})
			return
		}
		writeJSON(w, http.StatusOK, status)
	})

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		health := healthResponse{
			OK:                true,
			Service:           appName,
			Version:           version,
			GoVersion:         runtime.Version(),
			ResourceProfile:   resources.profileName,
			GoMaxProcs:        resources.goMaxProcs,
			GoMemoryLimitMiB:  resources.goMemoryLimitMiB,
			NetworkCacheSecs:  int(resources.networkQualityCacheTime / time.Second),
			StaffLoginEnabled: staffGatewayURL != "",
			StaffGatewayURL:   staffGatewayURL,
			StaffConsoleLogin: backend != nil,
			Time:              time.Now().UTC().Format(time.RFC3339),
		}

		if policy := licenses.versionPolicy(); policy != nil {
			health.MinimumVersion = policy.MinimumRequiredVersion
			health.LatestVersion = policy.LatestVersion
			health.UpdateDownloadURL = policy.DownloadURL
			if policy.updateRequiredFor(version) {
				health.UpdateRequired = true
				health.UpdateMessage = strings.TrimSpace(policy.Message)
				if health.UpdateMessage == "" {
					target := policy.LatestVersion
					if target == "" {
						target = policy.MinimumRequiredVersion
					}
					health.UpdateMessage = "Please update NPL Poker OS to version " + target + " to continue."
				}
			}
		}

		writeJSON(w, http.StatusOK, health)
	})

	mux.HandleFunc("GET /api/network-quality", func(w http.ResponseWriter, r *http.Request) {
		forceRefresh := r.URL.Query().Get("refresh") == "1"
		writeJSON(w, http.StatusOK, networkMonitor.snapshot(r.Context(), forceRefresh))
	})

	// Registered after the Go-owned endpoints so the licence routes can never
	// be shadowed by the bundled app.
	if backend != nil {
		backend.register(mux)
	}

	mux.Handle("/", spaHandler(assets))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-ID", requestID())
		mux.ServeHTTP(w, r)
	})
}

func spaHandler(assets fs.FS) http.Handler {
	fileServer := http.FileServerFS(assets)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		requestPath := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(r.URL.Path)), "/")
		if requestPath == "." || requestPath == "" {
			requestPath = "index.html"
		}

		if info, err := fs.Stat(assets, requestPath); err == nil && !info.IsDir() {
			if strings.HasPrefix(requestPath, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-store")
			}
			if contentType := mime.TypeByExtension(filepath.Ext(requestPath)); contentType != "" {
				w.Header().Set("Content-Type", contentType)
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		index, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			http.Error(w, "embedded UI is unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(index)
	})
}

func launchCaddy(ctx context.Context, cfg config, logger *log.Logger) (<-chan error, error) {
	executable, err := findCaddy()
	if err != nil {
		return nil, err
	}
	caddyfile, err := findRuntimeFile("Caddyfile")
	if err != nil {
		return nil, err
	}

	logDir := filepath.Join(filepath.Dir(caddyfile), "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}
	runtimeLog, err := os.OpenFile(
		filepath.Join(logDir, "caddy-runtime.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY,
		0o644,
	)
	if err != nil {
		return nil, fmt.Errorf("open Caddy runtime log: %w", err)
	}
	staffBind, staffPort, err := net.SplitHostPort(cfg.staffListen)
	if err != nil {
		_ = runtimeLog.Close()
		return nil, fmt.Errorf("parse staff gateway listener: %w", err)
	}
	if staffBind == "" {
		staffBind = "0.0.0.0"
	}
	desktopBind, _, err := net.SplitHostPort(cfg.publicListen)
	if err != nil {
		_ = runtimeLog.Close()
		return nil, fmt.Errorf("parse desktop gateway listener: %w", err)
	}
	if strings.EqualFold(desktopBind, "localhost") {
		desktopBind = "127.0.0.1"
	}

	cmd := exec.CommandContext(ctx, executable, "run", "--config", caddyfile, "--adapter", "caddyfile")
	cmd.Dir = filepath.Dir(caddyfile)
	cmd.Env = append(os.Environ(),
		"NPL_INTERNAL_LISTEN="+cfg.publicListen,
		"NPL_INTERNAL_BIND="+desktopBind,
		"NPL_INTERNAL_UPSTREAM="+cfg.backendListen,
		"NPL_STAFF_BIND="+staffBind,
		"NPL_STAFF_PORT="+staffPort,
		"GOMAXPROCS="+fmt.Sprintf("%d", cfg.resources.caddyMaxProcs),
		"GOMEMLIMIT="+fmt.Sprintf("%dMiB", cfg.resources.caddyMemoryLimitMiB),
	)
	cmd.Stdout = runtimeLog
	cmd.Stderr = runtimeLog
	configureBackgroundProcess(cmd)

	if err := cmd.Start(); err != nil {
		_ = runtimeLog.Close()
		return nil, fmt.Errorf("start Caddy: %w", err)
	}
	adoptBackgroundProcess(cmd)
	logger.Printf("started Caddy %s (pid %d)", executable, cmd.Process.Pid)

	done := make(chan error, 1)
	go func() {
		waitErr := cmd.Wait()
		_ = runtimeLog.Close()
		done <- waitErr
	}()
	return done, nil
}

func findCaddy() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("NPL_CADDY_EXE")); configured != "" {
		if info, err := os.Stat(configured); err == nil && !info.IsDir() {
			return configured, nil
		}
		return "", fmt.Errorf("NPL_CADDY_EXE does not point to a file: %s", configured)
	}

	names := []string{
		filepath.Join("redist", "caddy", executableName("caddy")),
		filepath.Join(".tools", "caddy", executableName("caddy")),
	}
	for _, name := range names {
		if path, ok := findNearExecutableOrWorkingDirectory(name); ok {
			return path, nil
		}
	}
	if path, err := exec.LookPath("caddy"); err == nil {
		return path, nil
	}
	return "", errors.New("Caddy was not found; run scripts/setup.ps1 first")
}

func findRuntimeFile(name string) (string, error) {
	if path, ok := findNearExecutableOrWorkingDirectory(name); ok {
		return path, nil
	}
	return "", fmt.Errorf("%s was not found beside the executable or in the working directory", name)
}

func findNearExecutableOrWorkingDirectory(relative string) (string, bool) {
	var roots []string
	if executable, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(executable))
	}
	if workingDirectory, err := os.Getwd(); err == nil {
		roots = append(roots, workingDirectory)
	}

	for _, root := range roots {
		candidate := filepath.Join(root, relative)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, true
		}
	}
	return "", false
}

func waitUntilReady(ctx context.Context, url string, caddyDone <-chan error, timeout time.Duration) error {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	client := &http.Client{Timeout: 500 * time.Millisecond}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-caddyDone:
			if err == nil {
				return errors.New("Caddy stopped before the gateway became ready")
			}
			return fmt.Errorf("Caddy failed before the gateway became ready: %w", err)
		case <-deadline.C:
			return fmt.Errorf("gateway did not become ready at %s within %s", url, timeout)
		case <-ticker.C:
			response, err := client.Get(url)
			if err == nil {
				_ = response.Body.Close()
				if response.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func executableName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func requestID() string {
	return fmt.Sprintf("%d", time.Now().UnixNano())
}
