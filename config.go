package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"
)

const mebibyte = int64(1024 * 1024)

type config struct {
	backendListen string
	publicListen  string
	direct        bool
	headless      bool
	resources     resourceSettings
}

type resourceSettings struct {
	profileName             string
	goMaxProcs              int
	goMemoryLimitMiB        int
	caddyMaxProcs           int
	caddyMemoryLimitMiB     int
	networkQualityCacheTime time.Duration
}

func parseConfig() (config, error) {
	direct := flag.Bool("direct", false, "serve the Go application directly without Caddy")
	headless := flag.Bool("headless", false, "run services without opening the desktop window")
	flag.Parse()

	return loadConfig(*direct, *headless, os.Getenv, runtime.NumCPU())
}

func loadConfig(
	direct bool,
	headless bool,
	getenv func(string) string,
	cpuCount int,
) (config, error) {
	resources, err := loadResourceSettings(getenv, cpuCount)
	if err != nil {
		return config{}, err
	}

	cfg := config{
		backendListen: envValue(getenv, "NPL_INTERNAL_BACKEND", "127.0.0.1:8788"),
		publicListen:  envValue(getenv, "NPL_INTERNAL_LISTEN", "127.0.0.1:8787"),
		direct:        direct,
		headless:      headless,
		resources:     resources,
	}
	if err := validateLoopbackAddress("NPL_INTERNAL_BACKEND", cfg.backendListen); err != nil {
		return config{}, err
	}
	if err := validateLoopbackAddress("NPL_INTERNAL_LISTEN", cfg.publicListen); err != nil {
		return config{}, err
	}
	if !cfg.direct && cfg.backendListen == cfg.publicListen {
		return config{}, fmt.Errorf("backend and public listen addresses must be different")
	}
	return cfg, nil
}

func loadResourceSettings(getenv func(string) string, cpuCount int) (resourceSettings, error) {
	profileName := strings.ToLower(envValue(getenv, "NPL_RESOURCE_PROFILE", "adaptive"))
	settings, err := resourceProfile(profileName, cpuCount)
	if err != nil {
		return resourceSettings{}, err
	}

	if settings.goMaxProcs, err = boundedIntEnv(
		getenv,
		"NPL_GO_MAX_PROCS",
		settings.goMaxProcs,
		1,
		32,
	); err != nil {
		return resourceSettings{}, err
	}
	if settings.goMemoryLimitMiB, err = boundedIntEnv(
		getenv,
		"NPL_GO_MEMORY_LIMIT_MIB",
		settings.goMemoryLimitMiB,
		64,
		2048,
	); err != nil {
		return resourceSettings{}, err
	}
	if settings.caddyMaxProcs, err = boundedIntEnv(
		getenv,
		"NPL_CADDY_MAX_PROCS",
		settings.caddyMaxProcs,
		1,
		16,
	); err != nil {
		return resourceSettings{}, err
	}
	if settings.caddyMemoryLimitMiB, err = boundedIntEnv(
		getenv,
		"NPL_CADDY_MEMORY_LIMIT_MIB",
		settings.caddyMemoryLimitMiB,
		64,
		1024,
	); err != nil {
		return resourceSettings{}, err
	}
	cacheSeconds, err := boundedIntEnv(
		getenv,
		"NPL_NETWORK_CACHE_SECONDS",
		int(settings.networkQualityCacheTime/time.Second),
		15,
		300,
	)
	if err != nil {
		return resourceSettings{}, err
	}
	settings.networkQualityCacheTime = time.Duration(cacheSeconds) * time.Second
	return settings, nil
}

func resourceProfile(name string, cpuCount int) (resourceSettings, error) {
	cpuCount = max(cpuCount, 1)

	switch name {
	case "adaptive":
		goWorkers := min(cpuCount, 4)
		if cpuCount > 4 {
			goWorkers = min(max(cpuCount/2, 2), 4)
		}
		caddyWorkers := 1
		if cpuCount >= 6 {
			caddyWorkers = 2
		}
		return resourceSettings{
			profileName:             name,
			goMaxProcs:              goWorkers,
			goMemoryLimitMiB:        192,
			caddyMaxProcs:           caddyWorkers,
			caddyMemoryLimitMiB:     96,
			networkQualityCacheTime: 30 * time.Second,
		}, nil
	case "low":
		return resourceSettings{
			profileName:             name,
			goMaxProcs:              min(cpuCount, 2),
			goMemoryLimitMiB:        128,
			caddyMaxProcs:           1,
			caddyMemoryLimitMiB:     64,
			networkQualityCacheTime: 45 * time.Second,
		}, nil
	case "balanced":
		return resourceSettings{
			profileName:             name,
			goMaxProcs:              min(cpuCount, 4),
			goMemoryLimitMiB:        256,
			caddyMaxProcs:           min(cpuCount, 2),
			caddyMemoryLimitMiB:     128,
			networkQualityCacheTime: 20 * time.Second,
		}, nil
	default:
		return resourceSettings{}, fmt.Errorf(
			"NPL_RESOURCE_PROFILE must be adaptive, low, or balanced; got %q",
			name,
		)
	}
}

func applyGoRuntimeLimits(settings resourceSettings) func() {
	previousMaxProcs := runtime.GOMAXPROCS(settings.goMaxProcs)
	previousMemoryLimit := debug.SetMemoryLimit(int64(settings.goMemoryLimitMiB) * mebibyte)

	return func() {
		runtime.GOMAXPROCS(previousMaxProcs)
		debug.SetMemoryLimit(previousMemoryLimit)
	}
}

func validateLoopbackAddress(name, address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%s must be a host:port address: %w", name, err)
	}
	if port == "" {
		return fmt.Errorf("%s requires a port", name)
	}
	if strings.EqualFold(host, "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("%s must use a loopback address, got %q", name, address)
	}
	return nil
}

func boundedIntEnv(
	getenv func(string) string,
	name string,
	fallback int,
	minimum int,
	maximum int,
) (int, error) {
	raw := strings.TrimSpace(getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, minimum, maximum)
	}
	return value, nil
}

func envValue(getenv func(string) string, name, fallback string) string {
	if value := strings.TrimSpace(getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envOrDefault(name, fallback string) string {
	return envValue(os.Getenv, name, fallback)
}
