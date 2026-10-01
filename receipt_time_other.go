//go:build !windows

package main

import "time"

func receiptLaptopLocalTime() time.Time {
	return time.Now()
}
