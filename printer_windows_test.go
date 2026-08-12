//go:build windows

package main

import (
	"bytes"
	"os"
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
		{Text: "NPL POKER", Center: true, Bold: true},
		{Text: "------------------------------------------------"},
		{Text: "BUY-IN", Center: true, Bold: true, Big: true},
		{Text: "Player: Test Player (NPL0000)"},
		{Text: "Table 3 - Seat 5", Bold: true},
		{Text: "Amount: $100.00"},
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
	t.Logf("rendered receipt PDF: %s (%d bytes)", output, len(rendered))
}
