//go:build windows

package main

import (
	"syscall"
	"time"
	"unsafe"
)

var receiptGetLocalTime = syscall.NewLazyDLL("kernel32.dll").NewProc("GetLocalTime")

// Read Windows on every print. Go's time.Local caches the Windows timezone and
// can otherwise keep using the old zone after the laptop settings change.
func receiptLaptopLocalTime() time.Time {
	var local syscall.Systemtime
	receiptGetLocalTime.Call(uintptr(unsafe.Pointer(&local)))
	// UTC is only a container for the wall-clock fields, not a timezone
	// conversion. These values already are the laptop's local date and time.
	return time.Date(int(local.Year), time.Month(local.Month), int(local.Day),
		int(local.Hour), int(local.Minute), int(local.Second),
		int(local.Milliseconds)*int(time.Millisecond), time.UTC)
}
