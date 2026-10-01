//go:build windows

package main

import (
	"fmt"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestReceiptClockMatchesWindowsEvenWithStaleGoLocalTimezone(t *testing.T) {
	// Simulate the cached Go zone being different from the laptop's current
	// setting, without changing the machine's clock or timezone.
	original := time.Local
	time.Local = time.FixedZone("stale Go timezone", 19*60*60)
	t.Cleanup(func() { time.Local = original })
	readWindows := func() string {
		var local syscall.Systemtime
		receiptGetLocalTime.Call(uintptr(unsafe.Pointer(&local)))
		return fmt.Sprintf("%04d-%02d-%02d %02d:%02d", local.Year, local.Month, local.Day, local.Hour, local.Minute)
	}
	before := readWindows()
	got := receiptLaptopLocalTime().Format("2006-01-02 15:04")
	after := readWindows()
	if got != before && got != after {
		t.Fatalf("expected actual Windows local time (%s or %s), got %s", before, after, got)
	}
}
