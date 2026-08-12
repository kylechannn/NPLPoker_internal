package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
)

// The receipt bridge: the bundled Laravel composes the receipt's lines
// (fully venue-customisable text, table/seat, amounts) and posts them
// here; this side prints them on the venue's receipt printer. Silent by
// design — a buy-in at the desk or on an admin phone prints without any
// dialog ever appearing.
//
// The queue decides the language. Thermal receipt printers (the venue's
// POS-80 class) get a RAW ESC/POS byte stream. Any other queue — a PDF
// printer on a dev machine, an office laser a venue picked by hand —
// gets the same receipt rendered as a text page through the Windows
// driver, because RAW ESC/POS bytes into a document printer come out as
// a blank receipt.

type receiptLine struct {
	Text   string `json:"text"`
	Center bool   `json:"center"`
	Bold   bool   `json:"bold"`
	Big    bool   `json:"big"`
}

type receiptPrintRequest struct {
	Printer string        `json:"printer"`
	Lines   []receiptLine `json:"lines"`
}

const (
	receiptMaxLines   = 80
	receiptMaxColumns = 64
)

// escposReceipt renders lines into the byte stream thermal printers
// speak: initialise, per-line alignment/emphasis/size, then feed and
// partial-cut. Kept deliberately plain — every ESC/POS printer since the
// nineties understands exactly these commands.
func escposReceipt(lines []receiptLine) []byte {
	buffer := []byte{0x1B, '@'} // ESC @ — initialise

	for _, line := range lines {
		align := byte(0)
		if line.Center {
			align = 1
		}
		buffer = append(buffer, 0x1B, 'a', align)

		if line.Bold {
			buffer = append(buffer, 0x1B, 'E', 1)
		}
		if line.Big {
			buffer = append(buffer, 0x1D, '!', 0x11) // double width + height
		}

		buffer = append(buffer, receiptFold(line.Text)...)

		if line.Big {
			buffer = append(buffer, 0x1D, '!', 0x00)
		}
		if line.Bold {
			buffer = append(buffer, 0x1B, 'E', 0)
		}

		buffer = append(buffer, '\n')
	}

	buffer = append(buffer, '\n', '\n', '\n', '\n')
	// GS V 66 n — feed n units, then partial cut. The extra feed walks the
	// footer clear of the cutter head on POS-80-class machines.
	buffer = append(buffer, 0x1D, 'V', 66, 3)
	return buffer
}

// printerSpeaksEscpos reports whether a queue name looks like a thermal
// receipt printer — the class of machine that expects RAW ESC/POS bytes.
// Everything else gets the driver-rendered document path instead.
func printerSpeaksEscpos(name string) bool {
	folded := strings.ToLower(name)
	for _, marker := range []string{"pos", "thermal", "receipt", "80mm", "58mm", "tm-t", "tm-m", "rp-", "btp-", "xp-8", "xp-5"} {
		if strings.Contains(folded, marker) {
			return true
		}
	}

	return false
}

// resolveReceiptPrinter turns "no printer picked" into a concrete queue
// name. An empty choice first hunts the installed queues for the venue's
// POS-80 (the standard NPL receipt machine), then any thermal-looking
// queue, and only then trusts the Windows default — which on fresh
// installs is commonly "Microsoft Print to PDF". Empty means the machine
// has no printers at all.
func resolveReceiptPrinter(requested string) string {
	if requested != "" {
		return requested
	}

	names, err := listPrinterNames()
	if err == nil {
		for _, name := range names {
			folded := strings.ToLower(name)
			if strings.Contains(folded, "pos-80") || strings.Contains(folded, "pos80") {
				return name
			}
		}
		for _, name := range names {
			if printerSpeaksEscpos(name) {
				return name
			}
		}
	}

	name, err := defaultPrinterName()
	if err != nil {
		return ""
	}

	return name
}

// printReceipt sends the composed lines to the queue in the language it
// actually speaks. Returns the mode used and, when the queue is a
// print-to-file device, the file the receipt landed in.
func printReceipt(printer string, lines []receiptLine) (mode string, output string, err error) {
	if printer == "" {
		return "", "", fmt.Errorf("no printer is installed on this machine")
	}

	if printerSpeaksEscpos(printer) {
		return "escpos", "", printRaw(printer, escposReceipt(lines))
	}

	output, err = printDocument(printer, lines)

	return "document", output, err
}

// receiptFold keeps the stream inside plain printable ASCII — codepage
// roulette across no-name thermal printers is not a fight worth having
// on a money receipt. Anything outside prints as '?'.
func receiptFold(text string) []byte {
	if len(text) > receiptMaxColumns*4 {
		text = text[:receiptMaxColumns*4]
	}

	folded := make([]byte, 0, len(text))
	for _, character := range text {
		switch {
		case character == '\t':
			folded = append(folded, ' ')
		case character >= 32 && character < 127:
			folded = append(folded, byte(character))
		default:
			folded = append(folded, '?')
		}
	}
	return folded
}

// registerReceiptPrinting mounts the print bridge. requireDesktopOrLocal:
// the desktop gateway and the machine's own processes (the bundled
// Laravel calls in over loopback) may print; the LAN staff listener may
// not.
func registerReceiptPrinting(mux *http.ServeMux) {
	mux.Handle("GET /api/print/printers", requireDesktopOrLocal(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		names, err := listPrinterNames()
		if err != nil {
			log.Printf("[npl-internal] printer enumeration failed: %v", err)
		}
		defaultName, _ := defaultPrinterName()
		auto := resolveReceiptPrinter("")
		autoMode := ""
		if auto != "" {
			autoMode = "document"
			if printerSpeaksEscpos(auto) {
				autoMode = "escpos"
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"printers":        names,
			"default_printer": defaultName,
			// What "no printer picked" actually resolves to — the UI shows
			// this so the venue can see whether the POS-80 was found or
			// receipts will render as document pages instead.
			"auto_printer": auto,
			"auto_mode":    autoMode,
		})
	})))

	mux.Handle("POST /api/print/receipt", requireDesktopOrLocal(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request receiptPrintRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "The receipt payload could not be read."})
			return
		}

		lines := request.Lines
		if len(lines) == 0 {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "The receipt has no lines."})
			return
		}
		if len(lines) > receiptMaxLines {
			lines = lines[:receiptMaxLines]
		}

		printer := resolveReceiptPrinter(strings.TrimSpace(request.Printer))
		mode, output, err := printReceipt(printer, lines)
		if err != nil {
			log.Printf("[npl-internal] receipt print failed (printer %q): %v", printer, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}

		if output != "" {
			log.Printf("[npl-internal] receipt printed (%d lines, printer %q, mode %s, saved to %s)", len(lines), printer, mode, output)
		} else {
			log.Printf("[npl-internal] receipt printed (%d lines, printer %q, mode %s)", len(lines), printer, mode)
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "printer": printer, "mode": mode, "output": output})
	})))
}
