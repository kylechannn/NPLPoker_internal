package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

// The receipt bridge: the bundled Laravel composes the receipt's lines
// (fully venue-customisable text, table/seat, amounts) and posts them
// here; this side turns them into an ESC/POS byte stream and spools it
// RAW to the venue's receipt printer. Silent by design — a buy-in at the
// desk or on an admin phone prints without any dialog ever appearing.

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

// resolveReceiptPrinter turns "no printer picked" into the right venue
// default. Fresh Windows installs commonly default to "Microsoft Print
// to PDF", which would swallow receipts silently — so an empty choice
// first hunts the installed queues for the venue's POS-80 (the standard
// NPL receipt machine), then any POS-named queue, and only then trusts
// the Windows default.
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
			if strings.Contains(strings.ToLower(name), "pos") {
				return name
			}
		}
	}

	// Empty keeps printRaw on the Windows default printer.
	return ""
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
		writeJSON(w, http.StatusOK, map[string]any{
			"printers":        names,
			"default_printer": defaultName,
			// What "no printer picked" actually resolves to — the UI shows
			// this so the venue can see the POS-80 was found.
			"auto_printer": resolveReceiptPrinter(""),
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
		if err := printRaw(printer, escposReceipt(lines)); err != nil {
			log.Printf("[npl-internal] receipt print failed (printer %q): %v", printer, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}

		log.Printf("[npl-internal] receipt printed (%d lines, printer %q)", len(lines), printer)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})))
}
