package main

import (
	"context"
	"math"
	"net"
	"sort"
	"sync"
	"time"
)

const (
	defaultNetworkQualityCacheDuration = 30 * time.Second
	networkProbeTimeout                = 1200 * time.Millisecond
)

var networkProbeTargets = []string{
	"1.1.1.1:443",
	"8.8.8.8:443",
	"9.9.9.9:443",
}

type networkQualityResponse struct {
	Online             bool   `json:"online"`
	Level              int    `json:"level"`
	Bars               int    `json:"bars"`
	Grade              string `json:"grade"`
	Summary            string `json:"summary"`
	LatencyMS          int    `json:"latency_ms"`
	JitterMS           int    `json:"jitter_ms"`
	ProbeSuccess       int    `json:"probe_success"`
	ProbeTotal         int    `json:"probe_total"`
	ReliabilityPercent int    `json:"reliability_percent"`
	CheckedAt          string `json:"checked_at"`
	CacheSeconds       int    `json:"cache_seconds"`
}

type networkQualityMonitor struct {
	mu              sync.Mutex
	cached          networkQualityResponse
	checkedAt       time.Time
	latencyHistory  []int
	smoothedQuality float64
	cacheDuration   time.Duration
}

func newNetworkQualityMonitor(cacheDuration time.Duration) *networkQualityMonitor {
	if cacheDuration <= 0 {
		cacheDuration = defaultNetworkQualityCacheDuration
	}
	return &networkQualityMonitor{cacheDuration: cacheDuration}
}

func (monitor *networkQualityMonitor) snapshot(ctx context.Context, force bool) networkQualityResponse {
	monitor.mu.Lock()
	defer monitor.mu.Unlock()

	if !force && !monitor.checkedAt.IsZero() && time.Since(monitor.checkedAt) < monitor.cacheDuration {
		return monitor.cached
	}

	latencies := probeInternetRoutes(ctx, networkProbeTargets)
	checkedAt := time.Now().UTC()
	successes := len(latencies)
	total := len(networkProbeTargets)

	response := networkQualityResponse{
		ProbeSuccess: successes,
		ProbeTotal:   total,
		CheckedAt:    checkedAt.Format(time.RFC3339),
		CacheSeconds: int(monitor.cacheDuration / time.Second),
	}

	if successes == 0 {
		response.Grade = "Offline"
		response.Summary = "No internet route detected"
		monitor.smoothedQuality = 0
		monitor.cached = response
		monitor.checkedAt = checkedAt
		return response
	}

	response.Online = true
	response.LatencyMS = median(latencies)
	response.ReliabilityPercent = int(math.Round(float64(successes) / float64(total) * 100))

	monitor.latencyHistory = append(monitor.latencyHistory, response.LatencyMS)
	if len(monitor.latencyHistory) > 6 {
		monitor.latencyHistory = monitor.latencyHistory[len(monitor.latencyHistory)-6:]
	}
	response.JitterMS = rollingJitter(monitor.latencyHistory)

	rawLevel := classifyNetworkQuality(response.LatencyMS, response.JitterMS, successes, total)
	if monitor.smoothedQuality == 0 {
		monitor.smoothedQuality = float64(rawLevel)
	} else {
		monitor.smoothedQuality = (monitor.smoothedQuality * 0.65) + (float64(rawLevel) * 0.35)
	}

	response.Level = clamp(int(math.Round(monitor.smoothedQuality)), 1, 10)
	if successes == 1 {
		response.Level = min(response.Level, 3)
	} else if successes == 2 {
		response.Level = min(response.Level, 6)
	}
	response.Bars = signalBars(response.Level)
	response.Grade, response.Summary = networkQualityCopy(response.Level)

	monitor.cached = response
	monitor.checkedAt = checkedAt
	return response
}

func probeInternetRoutes(ctx context.Context, targets []string) []int {
	probeCtx, cancel := context.WithTimeout(ctx, networkProbeTimeout+100*time.Millisecond)
	defer cancel()

	results := make(chan int, len(targets))
	var probes sync.WaitGroup
	for _, target := range targets {
		probes.Add(1)
		go func(address string) {
			defer probes.Done()
			startedAt := time.Now()
			connection, err := (&net.Dialer{Timeout: networkProbeTimeout}).DialContext(probeCtx, "tcp", address)
			if err != nil {
				return
			}
			_ = connection.Close()
			elapsed := max(int(time.Since(startedAt).Round(time.Millisecond)/time.Millisecond), 1)
			results <- elapsed
		}(target)
	}

	probes.Wait()
	close(results)

	latencies := make([]int, 0, len(targets))
	for latency := range results {
		latencies = append(latencies, latency)
	}
	return latencies
}

func classifyNetworkQuality(latencyMS, jitterMS, successes, total int) int {
	level := 2
	switch {
	case latencyMS <= 35:
		level = 10
	case latencyMS <= 60:
		level = 9
	case latencyMS <= 90:
		level = 8
	case latencyMS <= 140:
		level = 7
	case latencyMS <= 220:
		level = 6
	case latencyMS <= 350:
		level = 5
	case latencyMS <= 550:
		level = 4
	case latencyMS <= 850:
		level = 3
	}

	switch {
	case jitterMS > 140:
		level -= 2
	case jitterMS > 70:
		level--
	}

	if successes*3 <= total {
		level = min(level, 3)
	} else if successes < total {
		level = min(level, 6)
	}
	return clamp(level, 1, 10)
}

func signalBars(level int) int {
	if level <= 0 {
		return 0
	}
	return clamp((level+1)/2, 1, 5)
}

func networkQualityCopy(level int) (string, string) {
	switch clamp(level, 1, 10) {
	case 10:
		return "Excellent", "Fast and highly reliable"
	case 9:
		return "Very good", "Responsive and reliable"
	case 8:
		return "Strong", "Strong internet connection"
	case 7:
		return "Good", "Good for normal operations"
	case 6:
		return "Stable", "Stable with minor delay"
	case 5:
		return "Fair", "Usable with some delay"
	case 4:
		return "Weak", "Connection may feel slow"
	case 3:
		return "Poor", "Connection is unreliable"
	case 2:
		return "Very poor", "Frequent connection issues"
	default:
		return "Critical", "Internet route is barely available"
	}
}

func median(values []int) int {
	sorted := append([]int(nil), values...)
	sort.Ints(sorted)
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return int(math.Round(float64(sorted[middle-1]+sorted[middle]) / 2))
}

func rollingJitter(values []int) int {
	if len(values) < 2 {
		return 0
	}
	totalDifference := 0
	for index := 1; index < len(values); index++ {
		totalDifference += abs(values[index] - values[index-1])
	}
	return int(math.Round(float64(totalDifference) / float64(len(values)-1)))
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func clamp(value, minimum, maximum int) int {
	return min(max(value, minimum), maximum)
}
