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
	"sync"
	"sync/atomic"
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
	// A supervised process that dies is restarted after this pause, doubling
	// up to the max while it keeps dying and resetting once a start survives
	// a minute — a one-off PHP crash heals in seconds without a broken
	// install turning into a spawn storm.
	backendRestartDelay    = 3 * time.Second
	backendRestartDelayMax = 30 * time.Second
	backendHealthyUptime   = time.Minute
)

// One serve worker's current network identity. Replaced atomically on every
// supervised restart: the port is re-picked each time, so a crashed worker
// whose old port got taken (or squatted) never wedges into a failing loop —
// and traffic can never be proxied to whatever stole the old port.
type workerTarget struct {
	address string
	proxy   *httputil.ReverseProxy
}

type backendWorker struct {
	target   atomic.Pointer[workerTarget]
	inFlight atomic.Int64
}

// backendApp runs a small POOL of serve workers and load-balances requests
// across them. PHP's built-in server answers ONE request at a time per
// process (PHP_CLI_SERVER_WORKERS never worked on Windows), so a single
// worker used to serialise every desk screen behind the slowest request —
// one cloud-bound call could stall the seating poll, the room clock and
// the scan box all at once.
type backendApp struct {
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	workers []*backendWorker
	next    atomic.Uint64
}

// startBackendApp boots the bundled app: clear stale framework caches,
// migrate, re-cache config + routes, then `php artisan serve` workers on
// loopback ports of their own plus the scheduler and the resident sweepers —
// every process supervised, so a crash (or the sweepers' deliberate hourly
// exit) restarts in seconds. A missing PHP or app directory is not fatal:
// the console still runs, and the desk routes simply report that the local
// backend is unavailable rather than taking the whole window down.
//
// hostBridge is this Go host's own loopback address — handed to the PHP
// processes as NPL_HOST_BRIDGE so Laravel can call back for host-side work
// (receipt printing rides this).
func startBackendApp(ctx context.Context, hostBridge string, workerCount int) (*backendApp, error) {
	// Found the same way Caddy is: beside the executable for an install, or
	// in the working directory when run from a checkout.
	artisan, ok := findNearExecutableOrWorkingDirectory(filepath.FromSlash(backendAppDir + "/artisan"))
	if !ok {
		return nil, fmt.Errorf("bundled backend not found at %s", backendAppDir)
	}

	appDir := filepath.Dir(artisan)
	php := backendPHPBinary(filepath.Dir(filepath.Dir(appDir)))
	workerCount = max(1, workerCount)

	// NPL_APP_VERSION hands the ldflags-stamped host build down to PHP —
	// without it the bundled app heartbeats "dev" and the cloud's version
	// gate cannot see what this desk actually runs. The SAME environment
	// must reach every artisan run below: config:cache bakes env values
	// into the cached config, so caching under a different environment
	// than the workers run with would freeze the wrong values in.
	env := append(os.Environ(), "NPL_HOST_BRIDGE="+hostBridge, "NPL_APP_VERSION="+version)

	runArtisan := func(label string, args ...string) error {
		cmd := exec.CommandContext(ctx, php, args...)
		cmd.Dir = appDir
		cmd.Env = env
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		configureBackgroundProcess(cmd)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s: %w", label, err)
		}
		return nil
	}

	// Clear stale framework caches BEFORE anything boots the app: a venue
	// update copies new code over the install, and the previous run's
	// bootstrap/cache/config.php would otherwise feed migrate last
	// week's configuration. Targeted clears, deliberately NOT
	// optimize:clear — that would also flush the application cache and
	// wipe the persisted cloud-link state on every boot.
	for _, clear := range []string{"config:clear", "route:clear", "event:clear", "view:clear"} {
		if err := runArtisan(clear, "artisan", clear, "--no-interaction"); err != nil {
			log.Printf("[npl-internal] %s failed: %v", clear, err)
		}
	}

	// Bring the schema up to date BEFORE serving. Code updates ship with
	// migrations, and a query against a column that never got migrated in
	// takes whole features down (the wheel went dark exactly this way).
	// A no-op run costs well under a second; a failure is logged, not
	// fatal, so an odd DB state still leaves the console usable.
	if err := runArtisan("migrate", "artisan", "migrate", "--force", "--no-interaction"); err != nil {
		log.Printf("[npl-internal] migrate on boot failed (continuing with current schema): %v", err)
	}

	// Cache config + routes for the run: without this every request
	// re-parses ~30 config files and recompiles the route table. Run as
	// INDIVIDUAL commands, not `artisan optimize` — optimize exits 0 even
	// when a task inside it fails, which would leave a partial cache
	// standing silently. Any failure here rolls the whole set back to
	// uncached, which is always correct, just slower.
	cacheSteps := [][2]string{
		{"config:cache", "config:clear"},
		{"route:cache", "route:clear"},
		{"event:cache", "event:clear"},
	}
	for index, step := range cacheSteps {
		if err := runArtisan(step[0], "artisan", step[0], "--no-interaction"); err != nil {
			log.Printf("[npl-internal] %s failed (serving uncached): %v", step[0], err)
			for _, done := range cacheSteps[:index+1] {
				if clearErr := runArtisan(done[1], "artisan", done[1], "--no-interaction"); clearErr != nil {
					log.Printf("[npl-internal] %s after failed caching: %v", done[1], clearErr)
				}
			}
			break
		}
	}

	appCtx, cancel := context.WithCancel(ctx)
	app := &backendApp{cancel: cancel}

	for index := 0; index < workerCount; index++ {
		worker := &backendWorker{}
		app.workers = append(app.workers, worker)
		app.superviseWorker(appCtx, fmt.Sprintf("serve worker %d", index+1), worker, appDir, php, env)
	}

	// The remaining schedule entries in routes/console.php (the stale-desk
	// safety net) only fire if something runs them; `serve` alone never
	// does. The sub-minute cadences ride the resident sweepers instead —
	// two roles in two processes, so the 5s clock broadcast can never
	// queue behind a slow queue drain.
	app.supervise(appCtx, "scheduler", appDir, env, func() *exec.Cmd {
		return exec.CommandContext(appCtx, php, "artisan", "schedule:work")
	})
	app.supervise(appCtx, "broadcast sweeper", appDir, env, func() *exec.Cmd {
		return exec.CommandContext(appCtx, php, "artisan", "ops:sweep", "--role=broadcast")
	})
	app.supervise(appCtx, "drains sweeper", appDir, env, func() *exec.Cmd {
		return exec.CommandContext(appCtx, php, "artisan", "ops:sweep", "--role=drains")
	})

	ready, failures := app.waitReady(ctx)
	for _, failure := range failures {
		log.Printf("[npl-internal] %v", failure)
	}
	if ready == 0 {
		return app, errors.New("no bundled backend worker became ready")
	}

	log.Printf("[npl-internal] bundled backend ready — %d/%d serve worker(s): %s",
		ready, len(app.workers), strings.Join(app.addresses(), ", "))

	return app, nil
}

// superviseWorker keeps one serve worker alive, RE-PICKING its loopback
// port on every start and swapping the proxy target atomically — so a
// port lost to another process during the restart window costs one more
// restart, never a permanent failing loop.
func (a *backendApp) superviseWorker(ctx context.Context, name string, worker *backendWorker, appDir, php string, env []string) {
	a.supervise(ctx, name, appDir, env, func() *exec.Cmd {
		port, err := freeLoopbackPort()
		if err != nil {
			log.Printf("[npl-internal] %s: no free port: %v", name, err)
			return nil
		}

		address := fmt.Sprintf("127.0.0.1:%d", port)
		target, err := url.Parse("http://" + address)
		if err != nil {
			log.Printf("[npl-internal] %s: %v", name, err)
			return nil
		}

		proxy := httputil.NewSingleHostReverseProxy(target)
		proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, err error) {
			log.Printf("[npl-internal] bundled backend unreachable: %v", err)
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"ok":      false,
				"message": "The local backend is catching its breath — retry in a moment.",
			})
		}

		worker.target.Store(&workerTarget{address: address, proxy: proxy})

		return exec.CommandContext(ctx, php, "artisan", "serve", "--host=127.0.0.1", fmt.Sprintf("--port=%d", port))
	})
}

// supervise runs one artisan process and restarts it whenever it exits —
// a PHP crash, or the sweepers' deliberate max-runtime exit — until the
// app context is cancelled. The build callback constructs a fresh command
// per attempt (a nil return counts as a failed start).
func (a *backendApp) supervise(ctx context.Context, name, appDir string, env []string, build func() *exec.Cmd) {
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		delay := backendRestartDelay

		for {
			if ctx.Err() != nil {
				return
			}

			cmd := build()
			started := false
			startedAt := time.Now()

			if cmd != nil {
				cmd.Dir = appDir
				cmd.Env = env
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
				configureBackgroundProcess(cmd)

				if err := cmd.Start(); err != nil {
					log.Printf("[npl-internal] %s failed to start: %v", name, err)
				} else {
					started = true
					adoptBackgroundProcess(cmd)
					err := cmd.Wait()
					if ctx.Err() != nil {
						return
					}
					log.Printf("[npl-internal] %s exited after %s (%v) — restarting in %s",
						name, time.Since(startedAt).Round(time.Second), err, delay)
				}
			}

			if started && time.Since(startedAt) >= backendHealthyUptime {
				delay = backendRestartDelay
			}

			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}

			delay *= 2
			if delay > backendRestartDelayMax {
				delay = backendRestartDelayMax
			}
		}
	}()
}

// waitReady probes every serve worker's health route in parallel until it
// answers or the startup TTL runs out, and reports how many made it plus
// the individual failures — one sick worker must not read as "the backend
// is down" while its siblings serve fine.
func (a *backendApp) waitReady(ctx context.Context) (int, []error) {
	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		ready    int
		failures []error
	)

	for index, worker := range a.workers {
		wg.Add(1)
		go func(index int, worker *backendWorker) {
			defer wg.Done()

			target := worker.target.Load()
			if target == nil {
				mu.Lock()
				failures = append(failures, fmt.Errorf("serve worker %d never bound a port", index+1))
				mu.Unlock()
				return
			}

			if err := waitForBackend(ctx, "http://"+target.address+"/api/health", backendStartupTTL); err != nil {
				mu.Lock()
				failures = append(failures, fmt.Errorf("serve worker %d (%s): %w", index+1, target.address, err))
				mu.Unlock()
				return
			}

			mu.Lock()
			ready++
			mu.Unlock()
		}(index, worker)
	}

	wg.Wait()

	return ready, failures
}

// ServeHTTP picks the worker with the fewest requests in flight (ties
// rotate). Round-robin alone would keep dealing every Nth request to a
// worker privately occupied by a minutes-long job — Manual update runs
// over one request — while its siblings sit idle. The local API is
// stateless (no PHP sessions; state lives in SQLite shared by every
// worker), so any worker can answer any request.
func (a *backendApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	worker := a.pickWorker()
	if worker == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"message": "The local backend is not running. Restart NPL Poker Internal.",
		})
		return
	}

	target := worker.target.Load()
	if target == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"message": "The local backend is still starting — retry in a moment.",
		})
		return
	}

	worker.inFlight.Add(1)
	defer worker.inFlight.Add(-1)
	target.proxy.ServeHTTP(w, r)
}

func (a *backendApp) pickWorker() *backendWorker {
	if len(a.workers) == 0 {
		return nil
	}

	start := int(a.next.Add(1) % uint64(len(a.workers)))
	best := a.workers[start]
	bestLoad := best.inFlight.Load()

	for offset := 1; offset < len(a.workers); offset++ {
		candidate := a.workers[(start+offset)%len(a.workers)]
		if load := candidate.inFlight.Load(); load < bestLoad {
			best = candidate
			bestLoad = load
		}
	}

	return best
}

// baseURL is the Go host's own way into the bundled app (the staff-code
// resolver uses it) — any worker will do.
func (a *backendApp) baseURL() string {
	if a == nil {
		return ""
	}

	worker := a.pickWorker()
	if worker == nil {
		return ""
	}

	target := worker.target.Load()
	if target == nil {
		return ""
	}

	return "http://" + target.address
}

func (a *backendApp) addresses() []string {
	out := make([]string, 0, len(a.workers))
	for _, worker := range a.workers {
		if target := worker.target.Load(); target != nil {
			out = append(out, target.address)
		}
	}
	return out
}

// register attaches the operational API. Only /api/v1/ is handed over, so the
// Go host keeps exclusive ownership of the licence endpoints — a compromised
// or unlicensed backend must not be able to answer for them.
func (a *backendApp) register(mux *http.ServeMux) {
	mux.Handle("/api/v1/", a)
	mux.Handle("/media/", a)
}

func (a *backendApp) stop() {
	if a == nil {
		return
	}

	if a.cancel != nil {
		a.cancel()
	}

	// The context cancellation kills every supervised process; give the
	// supervisors a bounded moment to observe it and return.
	done := make(chan struct{})
	go func() {
		a.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
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
