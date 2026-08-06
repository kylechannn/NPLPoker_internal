//go:build !windows

package main

import "fmt"

// Receipt printing is a venue-desk feature; venue desks run Windows.
// Non-Windows builds (dev shells, CI) keep the endpoints alive but every
// print answers with a clear error instead of silently pretending.

func printRaw(string, []byte) error {
	return fmt.Errorf("receipt printing is only available on the Windows build")
}

func defaultPrinterName() (string, error) {
	return "", fmt.Errorf("receipt printing is only available on the Windows build")
}

func listPrinterNames() ([]string, error) {
	return nil, nil
}
