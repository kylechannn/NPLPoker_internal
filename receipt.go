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
	buffer = append(buffer, 0x1D, 'V', 66, 0) // GS V 66 — feed and partial cut
	return buffer
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

		printer := strings.TrimSpace(request.Printer)
		if err := printRaw(printer, escposReceipt(lines)); err != nil {
			log.Printf("[npl-internal] receipt print failed (printer %q): %v", printer, err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})))
}
