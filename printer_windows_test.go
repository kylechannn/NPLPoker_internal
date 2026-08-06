//go:build windows

package main

import "testing"

// Runs the real winspool calls on the actual build machine: proves the
// PRINTER_INFO_4W / DOC_INFO_1W struct layouts and the enumeration
// walk against live Windows, without feeding paper. On a venue laptop
// this logs the POS-80 the auto-resolution would pick.
func TestWinspoolEnumerationOnThisMachine(t *testing.T) {
	names, err := listPrinterNames()
	if err != nil {
		t.Fatalf("EnumPrintersW failed on this machine: %v", err)
	}
	t.Logf("installed printers: %q", names)

	defaultName, err := defaultPrinterName()
	if err != nil {
		t.Logf("no Windows default printer on this machine: %v", err)
	} else {
		t.Logf("windows default printer: %q", defaultName)
	}

	t.Logf("auto-resolved receipt printer: %q", resolveReceiptPrinter(""))
}
