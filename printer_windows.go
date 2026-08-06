//go:build windows

package main

import (
	"fmt"
	"syscall"
	"unsafe"
)

// Raw Windows printing via winspool — the receipt path. Receipts are
// ESC/POS byte streams sent straight to the queue with the RAW datatype,
// which is how thermal receipt printers expect to be spoken to: no
// driver rendering, no print dialog, no popups.
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
