package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// The bundled Laravel app that holds the operational data: the local mirror,
// the tournament clock and the operator's desk.
//
// The Go host owns its own small set of endpoints (licence, health, network
// quality) and hands everything under /api/v1/ to this app. Splitting it that
// way keeps the licence gate in Go — where it can refuse before any
// operational route is reachable — while the data work stays in Laravel where
// migrations and tests live.
const (
	backendAppDir     = "app/npl_internal"
	backendStartupTTL = 25 * time.Second
)

type backendApp struct {
	cmd       *exec.Cmd
	scheduler *exec.Cmd
	target    *url.URL
	proxy     *httputil.ReverseProxy
}

// startBackendApp boots `php artisan serve` for the bundled app on a loopback
// port of its own. A missing PHP or a missing app directory is not fatal: the
// console still runs, and the desk routes simply report that the local
// backend is unavailable rather than taking the whole window down.
func startBackendApp(ctx context.Context) (*backendApp, error) {
	// Found the same way Caddy is: beside the executable for an install, or
	// in the working directory when run from a checkout.
	artisan, ok := findNearExecutableOrWorkingDirectory(filepath.FromSlash(backendAppDir + "/artisan"))
	if !ok {
		return nil, fmt.Errorf("bundled backend not found at %s", backendAppDir)
	}

	appDir := filepath.Dir(artisan)
	php := backendPHPBinary(filepath.Dir(filepath.Dir(appDir)))
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, fmt.Errorf("no free port for the bundled backend: %w", err)
	}

	address := fmt.Sprintf("127.0.0.1:%d", port)

	// Bring the schema up to date BEFORE serving. Code updates ship with
	// migrations, and a query against a column that never got migrated in
	// takes whole features down (the wheel went dark exactly this way).
	// A no-op run costs well under a second; a failure is logged, not
	// fatal, so an odd DB state still leaves the console usable.
	migrate := exec.CommandContext(ctx, php, "artisan", "migrate", "--force", "--no-interaction")
	migrate.Dir = appDir
	migrate.Stdout = os.Stdout
	migrate.Stderr = os.Stderr
	configureBackgroundProcess(migrate)
	if err := migrate.Run(); err != nil {
		log.Printf("[npl-internal] migrate on boot failed (continuing with current schema): %v", err)
	}

	cmd := exec.CommandContext(ctx, php, "artisan", "serve", "--host=127.0.0.1", fmt.Sprintf("--port=%d", port))
	cmd.Dir = appDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	configureBackgroundProcess(cmd)

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("could not start the bundled backend: %w", err)
	}
	adoptBackgroundProcess(cmd)

	target, err := url.Parse("http://" + address)
	if err != nil {
		return nil, err
	}

	app := &backendApp{cmd: cmd, target: target, proxy: httputil.NewSingleHostReverseProxy(target)}

	// The schedules in routes/console.php (tournament broadcast, outbox
	// drain) only fire if something runs them; `serve` alone never does.
	scheduler := exec.CommandContext(ctx, php, "artisan", "schedule:work")
	scheduler.Dir = appDir
	scheduler.Stdout = os.Stdout
	scheduler.Stderr = os.Stderr
	configureBackgroundProcess(scheduler)
	if err := scheduler.Start(); err != nil {
		log.Printf("[npl-internal] scheduler failed to start (broadcast/outbox sweeps off): %v", err)
	} else {
		adoptBackgroundProcess(scheduler)
		app.scheduler = scheduler
	}

	app.proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
		log.Printf("[npl-internal] bundled backend unreachable: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok":      false,
			"message": "The local backend is not responding. Restart NPL Poker Internal.",
		})
	}

	if err := waitForBackend(ctx, "http://"+address+"/api/health", backendStartupTTL); err != nil {
		return app, fmt.Errorf("bundled backend did not become ready: %w", err)
	}

	log.Printf("[npl-internal] bundled backend ready on %s", address)

	return app, nil
}

// register attaches the operational API. Only /api/v1/ is handed over, so the
// Go host keeps exclusive ownership of the licence endpoints — a compromised
// or unlicensed backend must not be able to answer for them.
func (a *backendApp) register(mux *http.ServeMux) {
	mux.Handle("/api/v1/", a.proxy)
	mux.Handle("/media/", a.proxy)
}

func (a *backendApp) stop() {
	if a == nil {
		return
	}

	if a.scheduler != nil && a.scheduler.Process != nil {
		_ = a.scheduler.Process.Kill()
		_ = a.scheduler.Wait()
	}

	if a.cmd == nil || a.cmd.Process == nil {
		return
	}

	_ = a.cmd.Process.Kill()
	_ = a.cmd.Wait()
}

// backendPHPBinary prefers a PHP shipped alongside the install so a venue
// laptop needs nothing on its PATH; falls back to whatever PATH provides.
func backendPHPBinary(root string) string {
	candidates := []string{
		filepath.Join(root, ".tools", "php", "php.exe"),
		filepath.Join(root, ".tools", "php", "php"),
	}

	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}

	return "php"
}

func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		return 0, errors.New("unexpected listener address")
	}

	return addr.Port, nil
}

func waitForBackend(ctx context.Context, healthURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
		if err != nil {
			return err
		}

		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode < 500 {
				return nil
			}
		}

		time.Sleep(250 * time.Millisecond)
	}

	return fmt.Errorf("timed out after %s", strings.TrimSuffix(timeout.String(), "0s"))
}
