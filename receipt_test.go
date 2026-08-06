package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
