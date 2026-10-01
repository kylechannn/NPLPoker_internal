package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEscposReceiptFramesLinesWithInitAndCut(t *testing.T) {
	data := escposReceipt([]receiptLine{
		{Text: "NPL POKER", Center: true, Bold: true, Big: true},
		{Text: "Table 3 - Seat 5"},
	})

	if !bytes.HasPrefix(data, []byte{0x1B, '@'}) {
		t.Fatal("expected the stream to begin with ESC @ initialise")
	}
	if !bytes.HasSuffix(data, []byte{0x1D, 'V', 66, 3}) {
		t.Fatal("expected the stream to end with the feed-and-cut command")
	}
	if !bytes.Contains(data, []byte{0x1B, 'a', 1}) || !bytes.Contains(data, []byte{0x1B, 'a', 0}) {
		t.Fatal("expected both centered and left alignment commands")
	}
	if !bytes.Contains(data, []byte{0x1B, 'E', 1}) || !bytes.Contains(data, []byte{0x1B, 'E', 0}) {
		t.Fatal("expected bold to be switched on and back off")
	}
	if !bytes.Contains(data, []byte{0x1D, '!', 0x11}) || !bytes.Contains(data, []byte{0x1D, '!', 0x00}) {
		t.Fatal("expected double-size to be switched on and back off")
	}
	if !bytes.Contains(data, []byte("Table 3 - Seat 5")) {
		t.Fatal("expected the line text in the stream")
	}
}

func TestReceiptFoldKeepsMoneyReceiptsPlainASCII(t *testing.T) {
	folded := string(receiptFold("Café\tRéceipt №9"))
	if folded != "Caf? R?ceipt ?9" {
		t.Fatalf("unexpected fold result: %q", folded)
	}
}

func TestAnExplicitPrinterChoiceIsNeverSecondGuessed(t *testing.T) {
	if resolved := resolveReceiptPrinter("Front Desk POS-80"); resolved != "Front Desk POS-80" {
		t.Fatalf("expected the picked printer verbatim, got %q", resolved)
	}
}

func TestPrinterModeFollowsTheQueueName(t *testing.T) {
	// Thermal-class queues speak ESC/POS — the venue path, unchanged.
	for _, name := range []string{
		"POS-80", "POS80 Printer", "Front Desk POS-80",
		"EPSON TM-T82III Receipt", "Generic 80mm Thermal", "XP-80C",
	} {
		if !printerSpeaksEscpos(name) {
			t.Fatalf("expected %q to be treated as an ESC/POS thermal printer", name)
		}
	}

	// Document queues get driver-rendered pages — RAW ESC/POS into these
	// is exactly how blank receipts were produced.
	for _, name := range []string{
		"Microsoft Print to PDF", "Brother MFC-L2750DW series Printer",
		"OneNote (Desktop)", "Microsoft XPS Document Writer",
		"Adobe PDF", "HP LaserJet Pro M404", "Fax",
	} {
		if printerSpeaksEscpos(name) {
			t.Fatalf("expected %q to be treated as a document printer", name)
		}
	}
}

func TestReceiptBridgeIsHiddenFromTheStaffGateway(t *testing.T) {
	mux := http.NewServeMux()
	registerReceiptPrinting(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/print/receipt", strings.NewReader(`{"lines":[{"text":"x"}]}`))
	request.Header.Set("X-NPL-Gateway", "staff")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("expected the staff gateway to see nothing, got %d", response.Code)
	}
}

func TestReceiptBridgeRejectsAnEmptyReceipt(t *testing.T) {
	mux := http.NewServeMux()
	registerReceiptPrinting(mux)

	request := httptest.NewRequest(http.MethodPost, "/api/print/receipt", strings.NewReader(`{"lines":[]}`))
	request.Header.Set("X-NPL-Gateway", "desktop")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected an empty receipt to be refused, got %d", response.Code)
	}
}

func TestReceiptRasterFramesRowsForEscposAndWindows(t *testing.T) {
	raster := receiptRaster{Width: 10, Height: 2, Bits: []byte{0x80, 0x40, 0x01, 0x80}}
	want := []byte{0x1d, 'v', '0', 0, 2, 0, 2, 0, 0x80, 0x40, 0x01, 0x80}
	if got := raster.escpos(); !bytes.Equal(got, want) {
		t.Fatalf("incorrect raster dimensions/data: %v", got)
	}
	pixels := raster.dibPixels()
	if len(pixels) != 32*2 {
		t.Fatalf("DIB rows must be padded to four bytes: %d", len(pixels))
	}
	for y := 0; y < 2; y++ {
		for x := 0; x < 10; x++ {
			black := (y == 0 && (x == 0 || x == 9)) || (y == 1 && (x == 7 || x == 8))
			want := byte(255)
			if black {
				want = 0
			}
			for channel := 0; channel < 3; channel++ {
				if pixels[y*32+x*3+channel] != want {
					t.Fatalf("wrong pixel at (%d,%d), channel %d", x, y, channel)
				}
			}
		}
	}
}

func TestBundledReceiptLogoContainsBothBadgeAndWordmark(t *testing.T) {
	for _, width := range []int{304, 448} {
		logo := receiptLogoRaster(width)
		if logo.Width != width || logo.Height <= 80 || len(logo.Bits) != (width+7)/8*logo.Height {
			t.Fatalf("invalid %dpx logo shape: %+v", width, logo)
		}
		left, right := 0, 0
		for y := 0; y < logo.Height; y++ {
			for x := 0; x < width; x++ {
				if logo.Bits[y*((width+7)/8)+x/8]&(1<<(7-x%8)) != 0 {
					if x < width/3 {
						left++
					} else {
						right++
					}
				}
			}
		}
		if left < 1000 || right < 1000 {
			t.Fatalf("logo lost its badge or wordmark at %dpx: left=%d right=%d", width, left, right)
		}
	}
}

func TestEscposReceiptPrintsRasterLogoRulesAndWrapsForPaperWidth(t *testing.T) {
	for _, tt := range []struct {
		printer            string
		columns, logoWidth int
	}{
		{"POS-80", 48, 448}, {"Generic 58mm Thermal", 32, 304}, {"POS58", 32, 304},
	} {
		t.Run(tt.printer, func(t *testing.T) {
			name := strings.Repeat("X", tt.columns+5)
			data := escposReceiptForPrinter([]receiptLine{
				{Logo: true, Text: "ignored external content"}, {Divider: true},
				{Text: name, Big: true, Center: true}, {Text: "Safe\x1b@\x1dV"},
			}, tt.printer)
			logo := receiptLogoRaster(tt.logoWidth)
			if !bytes.Contains(data, logo.escpos()) {
				t.Fatal("missing real raster logo")
			}
			rule := []byte{0x1d, 'v', '0', 0, byte(tt.columns * 12 / 8), 0, 2, 0}
			if !bytes.Contains(data, rule) {
				t.Fatal("missing full-width raster rule")
			}
			wrappedName := strings.Join(receiptWrap(name, tt.columns/2), "\n")
			if !bytes.Contains(data, []byte(wrappedName)) {
				t.Fatal("large name must wrap to half the normal columns")
			}
			if bytes.Contains(data, []byte("ignored external")) || !bytes.Contains(data, []byte("Safe?@?V")) {
				t.Fatal("special blocks and ESC/POS injection must not print user control bytes")
			}
		})
	}
}

func TestReceiptWrapPreservesWordsAndLongIdentifiers(t *testing.T) {
	for _, tt := range []struct {
		text     string
		width    int
		expected string
	}{
		{"GianCarlo Pesce", 12, "GianCarlo|Pesce"},
		{"ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10, "ABCDEFGHIJ|KLMNOPQRST|UVWXYZ"},
		{"A B C", 2, "A|B|C"}, {"", 24, ""},
	} {
		if got := strings.Join(receiptWrap(tt.text, tt.width), "|"); got != tt.expected {
			t.Errorf("wrap %q: expected %q, got %q", tt.text, tt.expected, got)
		}
	}
}

func TestDocumentWrapMeasuresUnicodeAndStripsControlCharacters(t *testing.T) {
	measure := func(text string) int {
		width := 0
		for _, r := range text {
			if r > 127 {
				width += 2
			} else {
				width++
			}
		}
		return width
	}
	lines := receiptWrapMeasured("King's 中国 Venue\x00\nLongTitleWithoutSpaces", 8, measure)
	for _, line := range lines {
		if !utf8.ValidString(line) || measure(line) > 8 || strings.ContainsAny(line, "\x00\n") {
			t.Fatalf("invalid driver line %q", line)
		}
	}
	if joined := strings.Join(lines, ""); !strings.Contains(joined, "中国") || !strings.HasSuffix(joined, "LongTitleWithoutSpaces") {
		t.Fatalf("Unicode text was lost: %q", joined)
	}
}
