package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"unicode"
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
// gets the same receipt rendered as a document through the Windows
// driver, because RAW ESC/POS bytes into a document printer come out as
// a blank receipt.

type receiptLine struct {
	Text    string `json:"text"`
	Center  bool   `json:"center"`
	Bold    bool   `json:"bold"`
	Big     bool   `json:"big"`
	Logo    bool   `json:"logo,omitempty"`
	Divider bool   `json:"divider,omitempty"`
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
// partial-cut. Brand graphics and dividers use the standard GS v 0 raster
// command supported by the POS-80 receipt printer class.
func escposReceipt(lines []receiptLine) []byte {
	return escposReceiptForPrinter(lines, "POS-80")
}

func receiptPrinterColumns(printer string) int {
	folded := strings.ToLower(printer)
	for _, marker := range []string{"58mm", "58 mm", "pos-58", "pos58", "xp-5"} {
		if strings.Contains(folded, marker) {
			return 32
		}
	}
	return 48
}

func escposReceiptForPrinter(lines []receiptLine, printer string) []byte {
	buffer := []byte{0x1B, '@'} // ESC @ — initialise
	columns := receiptPrinterColumns(printer)

	for _, line := range lines {
		if line.Logo {
			width := 448
			if columns == 32 {
				width = 304
			}
			logo := receiptLogoRaster(width)
			buffer = append(buffer, 0x1B, 'a', 1)
			buffer = append(buffer, logo.escpos()...)
			buffer = append(buffer, '\n')
			continue
		}
		if line.Divider {
			// A thin raster rule fills the same width as 48/32 font-A cells.
			width := columns * 12
			rule := receiptRaster{Width: width, Height: 2, Bits: bytes.Repeat([]byte{0xff}, (width/8)*2)}
			buffer = append(buffer, 0x1B, 'a', 0)
			buffer = append(buffer, rule.escpos()...)
			buffer = append(buffer, '\n')
			continue
		}
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

		lineColumns := columns
		if line.Big {
			lineColumns /= 2
		}
		wrapped := receiptWrap(string(receiptFold(line.Text)), lineColumns)
		buffer = append(buffer, strings.Join(wrapped, "\n")...)

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
		return "escpos", "", printRaw(printer, escposReceiptForPrinter(lines, printer))
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

// receiptWrap prevents device auto-wrap from dropping centering or clipping
// large player/event names. Whitespace is split at word boundaries, with an
// explicit hard split for identifiers that exceed a full line.
func receiptWrap(text string, columns int) []string {
	if columns < 1 {
		columns = 1
	}
	runes := []rune(text)
	if len(runes) == 0 {
		return []string{""}
	}
	var result []string
	for len(runes) > columns {
		cut := columns
		for index := columns; index > 0; index-- {
			if runes[index] == ' ' {
				cut = index
				break
			}
		}
		result = append(result, string(runes[:cut]))
		runes = runes[cut:]
		for len(runes) > 0 && runes[0] == ' ' {
			runes = runes[1:]
		}
	}
	if len(runes) > 0 {
		result = append(result, string(runes))
	}
	return result
}

// The document driver can render Unicode and proportional fonts, so wrap by
// measured width there. Control characters are never interpreted as layout.
func receiptWrapMeasured(text string, width int, measure func(string) int) []string {
	runes := []rune(text)
	if len(runes) > receiptMaxColumns*4 {
		runes = runes[:receiptMaxColumns*4]
	}
	for index, character := range runes {
		if unicode.IsControl(character) {
			runes[index] = ' '
		}
	}
	if len(runes) == 0 {
		return []string{""}
	}
	var lines []string
	for len(runes) > 0 {
		cut := 1
		for cut < len(runes) && measure(string(runes[:cut+1])) <= width {
			cut++
		}
		if cut < len(runes) {
			for index := cut; index > 0; index-- {
				if runes[index] == ' ' {
					cut = index
					break
				}
			}
		}
		lines = append(lines, string(runes[:cut]))
		runes = runes[cut:]
		for len(runes) > 0 && runes[0] == ' ' {
			runes = runes[1:]
		}
	}
	return lines
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
