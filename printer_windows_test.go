//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

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

// Proves the PRINTER_INFO_2W layout against live Windows: the PDF queue
// must sit on PORTPROMPT:, which is exactly what printDocument keys its
// no-dialog file redirect on.
func TestPrinterPortNameOnThisMachine(t *testing.T) {
	names, err := listPrinterNames()
	if err != nil {
		t.Fatalf("EnumPrintersW failed on this machine: %v", err)
	}
	if !slices.Contains(names, "Microsoft Print to PDF") {
		t.Skip("Microsoft Print to PDF is not installed on this machine")
	}

	port, err := printerPortName("Microsoft Print to PDF")
	if err != nil {
		t.Fatalf("GetPrinterW failed: %v", err)
	}
	if port != "PORTPROMPT:" {
		t.Fatalf("expected the PDF queue on PORTPROMPT:, got %q", port)
	}
}

// The full document path against a real queue: renders a receipt through
// the Microsoft Print to PDF driver (redirected to the receipts folder,
// so no dialog and no paper) and checks an actual PDF with content came
// out. This is the path every non-thermal printer takes — the ESC/POS
// stream fed to these queues is precisely what used to come out blank.
func TestPrintDocumentRendersARealPDFOnThisMachine(t *testing.T) {
	names, err := listPrinterNames()
	if err != nil {
		t.Fatalf("EnumPrintersW failed on this machine: %v", err)
	}
	if !slices.Contains(names, "Microsoft Print to PDF") {
		t.Skip("Microsoft Print to PDF is not installed on this machine")
	}

	output, err := printDocument("Microsoft Print to PDF", []receiptLine{
		{Logo: true},
		{Text: "24/09/2026 6:30 PM", Center: true},
		{Text: "Kings Head Tavern", Center: true},
		{Text: "Kings Head Tavern", Center: true, Bold: true},
		{Text: "Guaranteed: $2,000", Center: true, Bold: true},
		{Divider: true},
		{Text: "TABLE 1", Center: true, Bold: true, Big: true},
		{Text: "SEAT 1", Center: true, Bold: true, Big: true},
		{Text: "GianCarlo Pesce", Center: true, Bold: true, Big: true},
		{Divider: true},
		{Text: "BUY-IN", Center: true},
		{Text: "$0.00", Center: true, Bold: true, Big: true},
		{Text: "Chips: 20,000", Center: true, Bold: true},
		{Text: ""},
		{Text: "Printed time unavailable", PrintedAt: true, Center: true},
		{Text: "npl.com.au", Center: true},
	})
	if err != nil {
		t.Fatalf("printDocument failed: %v", err)
	}
	if output == "" {
		t.Fatal("expected the PDF queue print to be redirected to a file")
	}
	t.Cleanup(func() { _ = os.Remove(output) })

	// The PDF device writes the file after the spooler drains — poll.
	deadline := time.Now().Add(20 * time.Second)
	var rendered []byte
	for time.Now().Before(deadline) {
		rendered, err = os.ReadFile(output)
		if err == nil && len(rendered) > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if len(rendered) == 0 {
		t.Fatalf("no PDF appeared at %s within 20s", output)
	}
	if !bytes.HasPrefix(rendered, []byte("%PDF")) {
		t.Fatalf("expected a PDF, got leading bytes %q", rendered[:min(8, len(rendered))])
	}
	if len(rendered) < 1000 {
		t.Fatalf("the rendered PDF is suspiciously small (%d bytes) — likely a blank page", len(rendered))
	}
	if !bytes.Contains(rendered, []byte("/Subtype /Image")) {
		t.Fatal("the receipt logo was not embedded in the document output")
	}
	// Optional local review artifact, still using only the PDF virtual queue.
	if preview := os.Getenv("NPL_RECEIPT_PREVIEW_PATH"); preview != "" {
		if !filepath.IsAbs(preview) {
			t.Fatal("NPL_RECEIPT_PREVIEW_PATH must be absolute")
		}
		if err := os.WriteFile(preview, rendered, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("saved review preview: %s", preview)
	}
	t.Logf("rendered receipt PDF: %s (%d bytes)", output, len(rendered))
}
