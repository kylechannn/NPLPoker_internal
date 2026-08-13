//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// Raw Windows printing via winspool — the thermal receipt path. Receipts
// are ESC/POS byte streams sent straight to the queue with the RAW
// datatype, which is how thermal receipt printers expect to be spoken
// to: no driver rendering, no print dialog, no popups. Non-thermal
// queues instead go through printDocument below, which renders the same
// receipt as a text page via GDI so the driver understands it.
var (
	winspoolDLL            = syscall.NewLazyDLL("winspool.drv")
	procOpenPrinterW       = winspoolDLL.NewProc("OpenPrinterW")
	procClosePrinter       = winspoolDLL.NewProc("ClosePrinter")
	procStartDocPrinterW   = winspoolDLL.NewProc("StartDocPrinterW")
	procEndDocPrinter      = winspoolDLL.NewProc("EndDocPrinter")
	procStartPagePrinter   = winspoolDLL.NewProc("StartPagePrinter")
	procEndPagePrinter     = winspoolDLL.NewProc("EndPagePrinter")
	procWritePrinter       = winspoolDLL.NewProc("WritePrinter")
	procGetDefaultPrinterW = winspoolDLL.NewProc("GetDefaultPrinterW")
	procEnumPrintersW      = winspoolDLL.NewProc("EnumPrintersW")
	procGetPrinterW        = winspoolDLL.NewProc("GetPrinterW")

	gdi32DLL                  = syscall.NewLazyDLL("gdi32.dll")
	procCreateDCW             = gdi32DLL.NewProc("CreateDCW")
	procDeleteDC              = gdi32DLL.NewProc("DeleteDC")
	procStartDocW             = gdi32DLL.NewProc("StartDocW")
	procEndDoc                = gdi32DLL.NewProc("EndDoc")
	procStartPage             = gdi32DLL.NewProc("StartPage")
	procEndPage               = gdi32DLL.NewProc("EndPage")
	procTextOutW              = gdi32DLL.NewProc("TextOutW")
	procCreateFontW           = gdi32DLL.NewProc("CreateFontW")
	procSelectObject          = gdi32DLL.NewProc("SelectObject")
	procDeleteObject          = gdi32DLL.NewProc("DeleteObject")
	procGetDeviceCaps         = gdi32DLL.NewProc("GetDeviceCaps")
	procGetTextExtentPoint32W = gdi32DLL.NewProc("GetTextExtentPoint32W")
)

// DOC_INFO_1W
type docInfo1 struct {
	docName    *uint16
	outputFile *uint16
	datatype   *uint16
}

// PRINTER_INFO_4W — the light enumeration record.
type printerInfo4 struct {
	printerName *uint16
	serverName  *uint16
	attributes  uint32
}

func defaultPrinterName() (string, error) {
	var size uint32
	_, _, _ = procGetDefaultPrinterW.Call(0, uintptr(unsafe.Pointer(&size)))
	if size == 0 {
		return "", fmt.Errorf("Windows has no default printer set")
	}

	buffer := make([]uint16, size)
	ret, _, callErr := procGetDefaultPrinterW.Call(
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return "", fmt.Errorf("read the default printer: %w", callErr)
	}

	return syscall.UTF16ToString(buffer), nil
}

func listPrinterNames() ([]string, error) {
	// PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
	const flags = 0x00000002 | 0x00000004

	var needed, returned uint32
	_, _, _ = procEnumPrintersW.Call(flags, 0, 4, 0, 0,
		uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		return nil, nil
	}

	buffer := make([]byte, needed)
	ret, _, callErr := procEnumPrintersW.Call(flags, 0, 4,
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(needed),
		uintptr(unsafe.Pointer(&needed)), uintptr(unsafe.Pointer(&returned)))
	if ret == 0 {
		return nil, fmt.Errorf("list printers: %w", callErr)
	}

	names := make([]string, 0, returned)
	recordSize := unsafe.Sizeof(printerInfo4{})
	for index := uintptr(0); index < uintptr(returned); index++ {
		record := (*printerInfo4)(unsafe.Pointer(uintptr(unsafe.Pointer(&buffer[0])) + index*recordSize))
		if record.printerName != nil {
			names = append(names, utf16PtrToString(record.printerName))
		}
	}

	return names, nil
}

func utf16PtrToString(pointer *uint16) string {
	if pointer == nil {
		return ""
	}
	length := 0
	for tmp := pointer; *tmp != 0; tmp = (*uint16)(unsafe.Pointer(uintptr(unsafe.Pointer(tmp)) + 2)) {
		length++
	}
	return syscall.UTF16ToString(unsafe.Slice(pointer, length))
}

// printRaw spools one RAW document to the named printer (empty name =
// the Windows default). Fully silent: success or an error string, no UI.
func printRaw(printerName string, data []byte) error {
	if len(data) == 0 {
		return fmt.Errorf("nothing to print")
	}

	if printerName == "" {
		name, err := defaultPrinterName()
		if err != nil {
			return err
		}
		printerName = name
	}

	namePtr, err := syscall.UTF16PtrFromString(printerName)
	if err != nil {
		return fmt.Errorf("printer name: %w", err)
	}

	var handle syscall.Handle
	ret, _, callErr := procOpenPrinterW.Call(uintptr(unsafe.Pointer(namePtr)), uintptr(unsafe.Pointer(&handle)), 0)
	if ret == 0 {
		return fmt.Errorf("open printer %q: %w", printerName, callErr)
	}
	defer procClosePrinter.Call(uintptr(handle)) //nolint:errcheck

	docName, _ := syscall.UTF16PtrFromString("NPL receipt")
	datatype, _ := syscall.UTF16PtrFromString("RAW")
	document := docInfo1{docName: docName, datatype: datatype}

	ret, _, callErr = procStartDocPrinterW.Call(uintptr(handle), 1, uintptr(unsafe.Pointer(&document)))
	if ret == 0 {
		return fmt.Errorf("start the receipt document: %w", callErr)
	}
	defer procEndDocPrinter.Call(uintptr(handle)) //nolint:errcheck

	ret, _, callErr = procStartPagePrinter.Call(uintptr(handle))
	if ret == 0 {
		return fmt.Errorf("start the receipt page: %w", callErr)
	}
	defer procEndPagePrinter.Call(uintptr(handle)) //nolint:errcheck

	var written uint32
	ret, _, callErr = procWritePrinter.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&data[0])),
		uintptr(len(data)),
		uintptr(unsafe.Pointer(&written)),
	)
	if ret == 0 {
		return fmt.Errorf("write to printer %q: %w", printerName, callErr)
	}
	if int(written) != len(data) {
		return fmt.Errorf("printer %q accepted %d of %d bytes", printerName, written, len(data))
	}

	return nil
}

// PRINTER_INFO_2W — the detailed record; only the port name is read.
type printerInfo2 struct {
	serverName         *uint16
	printerName        *uint16
	shareName          *uint16
	portName           *uint16
	driverName         *uint16
	comment            *uint16
	location           *uint16
	devMode            uintptr
	sepFile            *uint16
	printProcessor     *uint16
	datatype           *uint16
	parameters         *uint16
	securityDescriptor uintptr
	attributes         uint32
	priority           uint32
	defaultPriority    uint32
	startTime          uint32
	untilTime          uint32
	status             uint32
	jobs               uint32
	averagePPM         uint32
}

// printerPortName reads which port a queue prints through — the honest
// way to recognise print-to-file devices ("Microsoft Print to PDF" sits
// on PORTPROMPT:, which pops a save dialog).
func printerPortName(printerName string) (string, error) {
	namePtr, err := syscall.UTF16PtrFromString(printerName)
	if err != nil {
		return "", fmt.Errorf("printer name: %w", err)
	}

	var handle syscall.Handle
	ret, _, callErr := procOpenPrinterW.Call(uintptr(unsafe.Pointer(namePtr)), uintptr(unsafe.Pointer(&handle)), 0)
	if ret == 0 {
		return "", fmt.Errorf("open printer %q: %w", printerName, callErr)
	}
	defer procClosePrinter.Call(uintptr(handle)) //nolint:errcheck

	var needed uint32
	_, _, _ = procGetPrinterW.Call(uintptr(handle), 2, 0, 0, uintptr(unsafe.Pointer(&needed)))
	if needed == 0 {
		return "", fmt.Errorf("read printer %q details", printerName)
	}

	buffer := make([]byte, needed)
	ret, _, callErr = procGetPrinterW.Call(uintptr(handle), 2,
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(needed), uintptr(unsafe.Pointer(&needed)))
	if ret == 0 {
		return "", fmt.Errorf("read printer %q details: %w", printerName, callErr)
	}

	info := (*printerInfo2)(unsafe.Pointer(&buffer[0]))

	return utf16PtrToString(info.portName), nil
}

// GDI document printing — the non-thermal receipt path.

// DOCINFOW for StartDocW.
type gdiDocInfo struct {
	cbSize       int32
	lpszDocName  *uint16
	lpszOutput   *uint16
	lpszDatatype *uint16
	fwType       uint32
}

type gdiSize struct {
	cx int32
	cy int32
}

// GetDeviceCaps indexes.
const (
	gdiHorzRes    = 8
	gdiVertRes    = 10
	gdiLogPixelsX = 88
	gdiLogPixelsY = 90
)

// Keeps two receipts printed within the same second from landing on the
// same PDF filename (a first buy-in and its jackpot arrive as one batch).
var receiptDocumentCounter atomic.Uint64

func gdiCap(hdc uintptr, index int) int {
	ret, _, _ := procGetDeviceCaps.Call(hdc, uintptr(index))

	return int(ret)
}

// printDocument renders the receipt as a text page through the queue's
// own driver — the path for every non-thermal printer, where RAW ESC/POS
// bytes would come out blank. Print-to-file queues (port PORTPROMPT:)
// are redirected into the app's receipts folder so no save dialog ever
// appears; the saved file's path is returned.
func printDocument(printerName string, lines []receiptLine) (string, error) {
	if printerName == "" {
		return "", fmt.Errorf("no printer is installed on this machine")
	}

	outputFile := ""
	if port, err := printerPortName(printerName); err == nil && strings.EqualFold(strings.TrimSpace(port), "PORTPROMPT:") {
		directory, err := filepath.Abs("receipts")
		if err == nil {
			if err := os.MkdirAll(directory, 0o755); err == nil {
				outputFile = filepath.Join(directory, fmt.Sprintf(
					"receipt-%s-%d.pdf", time.Now().Format("20060102-150405"), receiptDocumentCounter.Add(1)))
			}
		}
	}

	namePtr, err := syscall.UTF16PtrFromString(printerName)
	if err != nil {
		return "", fmt.Errorf("printer name: %w", err)
	}

	hdc, _, callErr := procCreateDCW.Call(0, uintptr(unsafe.Pointer(namePtr)), 0, 0)
	if hdc == 0 {
		return "", fmt.Errorf("open a device context for %q: %w", printerName, callErr)
	}
	defer procDeleteDC.Call(hdc) //nolint:errcheck

	dpiX := gdiCap(hdc, gdiLogPixelsX)
	dpiY := gdiCap(hdc, gdiLogPixelsY)
	pageWidth := gdiCap(hdc, gdiHorzRes)
	pageHeight := gdiCap(hdc, gdiVertRes)
	if dpiX <= 0 || dpiY <= 0 || pageWidth <= 0 || pageHeight <= 0 {
		return "", fmt.Errorf("printer %q reported no printable page", printerName)
	}
	marginX := dpiX / 2
	marginY := dpiY / 2

	// Receipts are monospace so the divider rules line up, like the slip.
	face, _ := syscall.UTF16PtrFromString("Consolas")
	makeFont := func(points, weight int) uintptr {
		font, _, _ := procCreateFontW.Call(
			uintptr(-(points*dpiY)/72), 0, 0, 0, uintptr(weight),
			0, 0, 0,
			1, // DEFAULT_CHARSET
			0, 0, 0,
			0x31, // FIXED_PITCH | FF_MODERN
			uintptr(unsafe.Pointer(face)),
		)

		return font
	}
	fontBase := makeFont(11, 400)
	fontBold := makeFont(11, 700)
	fontBig := makeFont(22, 700)
	defer func() {
		for _, font := range []uintptr{fontBase, fontBold, fontBig} {
			if font != 0 {
				procDeleteObject.Call(font) //nolint:errcheck
			}
		}
	}()
	if fontBase == 0 || fontBold == 0 || fontBig == 0 {
		return "", fmt.Errorf("printer %q: the receipt font could not be created", printerName)
	}

	docName, _ := syscall.UTF16PtrFromString("NPL receipt")
	document := gdiDocInfo{cbSize: int32(unsafe.Sizeof(gdiDocInfo{})), lpszDocName: docName}
	if outputFile != "" {
		document.lpszOutput, _ = syscall.UTF16PtrFromString(outputFile)
	}

	jobID, _, callErr := procStartDocW.Call(hdc, uintptr(unsafe.Pointer(&document)))
	if int32(jobID) <= 0 {
		return "", fmt.Errorf("start the receipt document on %q: %w", printerName, callErr)
	}

	if ret, _, callErr := procStartPage.Call(hdc); int32(ret) <= 0 {
		procEndDoc.Call(hdc) //nolint:errcheck

		return "", fmt.Errorf("start the receipt page on %q: %w", printerName, callErr)
	}

	y := marginY
	for _, line := range lines {
		font := fontBase
		switch {
		case line.Big:
			font = fontBig
		case line.Bold:
			font = fontBold
		}
		procSelectObject.Call(hdc, font) //nolint:errcheck

		// Blank custom lines still take vertical space, like a paper feed.
		text := line.Text
		measured := text
		if strings.TrimSpace(measured) == "" {
			measured = "X"
		}
		measureUTF, err := syscall.UTF16FromString(measured)
		if err != nil {
			continue
		}
		var size gdiSize
		procGetTextExtentPoint32W.Call(hdc, //nolint:errcheck
			uintptr(unsafe.Pointer(&measureUTF[0])), uintptr(len(measureUTF)-1), uintptr(unsafe.Pointer(&size)))
		lineHeight := int(size.cy)
		if lineHeight <= 0 {
			lineHeight = dpiY / 6
		}

		if y+lineHeight > pageHeight-marginY {
			procEndPage.Call(hdc) //nolint:errcheck
			if ret, _, callErr := procStartPage.Call(hdc); int32(ret) <= 0 {
				procEndDoc.Call(hdc) //nolint:errcheck

				return "", fmt.Errorf("start a follow-on receipt page on %q: %w", printerName, callErr)
			}
			y = marginY
		}

		if strings.TrimSpace(text) != "" {
			textUTF, err := syscall.UTF16FromString(text)
			if err == nil {
				x := marginX
				if line.Center {
					if width := int(size.cx); width < pageWidth-2*marginX {
						x = marginX + (pageWidth-2*marginX-width)/2
					}
				}
				procTextOutW.Call(hdc, uintptr(x), uintptr(y), //nolint:errcheck
					uintptr(unsafe.Pointer(&textUTF[0])), uintptr(len(textUTF)-1))
			}
		}

		y += lineHeight * 5 / 4
	}

	procEndPage.Call(hdc) //nolint:errcheck
	if ret, _, callErr := procEndDoc.Call(hdc); int32(ret) <= 0 {
		return "", fmt.Errorf("finish the receipt document on %q: %w", printerName, callErr)
	}

	return outputFile, nil
}
