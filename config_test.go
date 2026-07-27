package main

import (
	"strings"
	"testing"
	"time"
)

func TestAdaptiveResourceProfile(t *testing.T) {
	settings, err := loadResourceSettings(func(string) string { return "" }, 8)
	if err != nil {
		t.Fatalf("load adaptive settings: %v", err)
	}

	if settings.profileName != "adaptive" {
		t.Fatalf("expected adaptive profile, got %q", settings.profileName)
	}
	if settings.goMaxProcs != 4 || settings.caddyMaxProcs != 2 {
		t.Fatalf("unexpected worker limits: %+v", settings)
	}
	if settings.goMemoryLimitMiB != 192 || settings.caddyMemoryLimitMiB != 96 {
		t.Fatalf("unexpected memory limits: %+v", settings)
	}
	if settings.networkQualityCacheTime != 30*time.Second {
		t.Fatalf("unexpected network cache: %s", settings.networkQualityCacheTime)
	}
}

func TestLowResourceProfileAndOverrides(t *testing.T) {
	values := map[string]string{
		"NPL_RESOURCE_PROFILE":       "low",
		"NPL_GO_MAX_PROCS":           "1",
		"NPL_NETWORK_CACHE_SECONDS":  "60",
		"NPL_CADDY_MEMORY_LIMIT_MIB": "80",
	}
	settings, err := loadResourceSettings(func(name string) string { return values[name] }, 4)
	if err != nil {
		t.Fatalf("load low-resource settings: %v", err)
	}

	if settings.profileName != "low" || settings.goMaxProcs != 1 {
		t.Fatalf("unexpected low-resource workers: %+v", settings)
	}
	if settings.caddyMaxProcs != 1 || settings.caddyMemoryLimitMiB != 80 {
		t.Fatalf("unexpected Caddy settings: %+v", settings)
	}
	if settings.networkQualityCacheTime != time.Minute {
		t.Fatalf("expected one-minute network cache, got %s", settings.networkQualityCacheTime)
	}
}

func TestConfigRejectsExternalListenAddress(t *testing.T) {
	values := map[string]string{
		"NPL_INTERNAL_LISTEN": "0.0.0.0:8787",
	}
	_, err := loadConfig(false, false, func(name string) string { return values[name] }, 4)
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("expected loopback validation error, got %v", err)
	}
}

func TestConfigRejectsInvalidResourceValues(t *testing.T) {
	values := map[string]string{
		"NPL_GO_MEMORY_LIMIT_MIB": "16",
	}
	_, err := loadResourceSettings(func(name string) string { return values[name] }, 4)
	if err == nil || !strings.Contains(err.Error(), "NPL_GO_MEMORY_LIMIT_MIB") {
		t.Fatalf("expected memory validation error, got %v", err)
	}
}

func TestConfigAllowsDedicatedPrivateStaffGateway(t *testing.T) {
	values := map[string]string{
		"NPL_STAFF_LISTEN":     "0.0.0.0:8790",
		"NPL_STAFF_PUBLIC_URL": "http://192.168.10.25:8790",
	}
	cfg, err := loadConfig(false, false, func(name string) string { return values[name] }, 4)
	if err != nil {
		t.Fatalf("expected private staff gateway config: %v", err)
	}
	if cfg.staffListen != "0.0.0.0:8790" || cfg.staffPublicURL != values["NPL_STAFF_PUBLIC_URL"] {
		t.Fatalf("unexpected staff gateway config: %+v", cfg)
	}
}

func TestConfigRejectsPublicStaffListenAddress(t *testing.T) {
	values := map[string]string{
		"NPL_STAFF_LISTEN": "8.8.8.8:8790",
	}
	_, err := loadConfig(false, false, func(name string) string { return values[name] }, 4)
	if err == nil || !strings.Contains(err.Error(), "private LAN") {
		t.Fatalf("expected private LAN validation error, got %v", err)
	}
}
