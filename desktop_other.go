//go:build !windows

package main

import "errors"

func runDesktopWindow(_ string) error {
	return errors.New("the NPL Poker desktop shell is currently available on Windows only")
}

func showNativeError(_, _ string) {}

func minimizeRoomClockWindow() {}
