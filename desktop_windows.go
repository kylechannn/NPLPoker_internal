//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	wv "github.com/jchv/go-webview2"
)

const desktopWindowTitle = "NPL Poker Operational System"

var (
	dwmAPI                = syscall.NewLazyDLL("dwmapi.dll")
	dwmSetWindowAttribute = dwmAPI.NewProc("DwmSetWindowAttribute")
	user32                = syscall.NewLazyDLL("user32.dll")
	messageBoxW           = user32.NewProc("MessageBoxW")
	getWindowLongPtrW     = user32.NewProc("GetWindowLongPtrW")
	setWindowLongPtrW     = user32.NewProc("SetWindowLongPtrW")
	setWindowPos          = user32.NewProc("SetWindowPos")
	showWindow            = user32.NewProc("ShowWindow")
	isZoomed              = user32.NewProc("IsZoomed")
	releaseCapture        = user32.NewProc("ReleaseCapture")
	sendMessageW          = user32.NewProc("SendMessageW")
	setWindowRgn          = user32.NewProc("SetWindowRgn")
	getWindowRect         = user32.NewProc("GetWindowRect")
	getDpiForWindow       = user32.NewProc("GetDpiForWindow")
	gdi32                 = syscall.NewLazyDLL("gdi32.dll")
	createRoundRectRgn    = gdi32.NewProc("CreateRoundRectRgn")
	createRectRgn         = gdi32.NewProc("CreateRectRgn")
	combineRgn            = gdi32.NewProc("CombineRgn")
	deleteObject          = gdi32.NewProc("DeleteObject")
)

const (
	dwmUseImmersiveDarkMode   = 20
	dwmWindowCornerPreference = 33
	dwmBorderColor            = 34
	dwmCaptionColor           = 35
	dwmTextColor              = 36
	dwmRoundWindow            = 2
	windowStyleIndex          = ^uintptr(15)
	windowStyleCaption        = uintptr(0x00C00000)
	setPositionNoSize         = uintptr(0x0001)
	setPositionNoMove         = uintptr(0x0002)
	setPositionNoZOrder       = uintptr(0x0004)
	setPositionFrameChanged   = uintptr(0x0020)
	showMinimized             = uintptr(6)
	showMaximized             = uintptr(3)
	showRestored              = uintptr(9)
	windowMessageClose        = uintptr(0x0010)
	windowMessageNCLButton    = uintptr(0x00A1)
	hitTestCaption            = uintptr(2)
	messageBoxOK              = 0x00000000
	messageBoxIconError       = 0x00000010
)

func runDesktopWindow(target string) error {
	dataPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "NPLPoker", "OperationalSystem", "WebView2")
	if err := os.MkdirAll(dataPath, 0o755); err != nil {
		return err
	}

	window := wv.NewWithOptions(wv.WebViewOptions{
		Debug:     false,
		DataPath:  dataPath,
		AutoFocus: true,
		WindowOptions: wv.WindowOptions{
			Title:  desktopWindowTitle,
			Width:  1440,
			Height: 900,
			Center: true,
		},
	})
	if window == nil {
		return errors.New("Microsoft Edge WebView2 Runtime is required to open the operational system")
	}
	defer window.Destroy()

	window.SetTitle(desktopWindowTitle)
	window.SetSize(1024, 680, wv.HintMin)
	hwnd := uintptr(window.Window())
	applyDesktopWindowStyle(hwnd)
	applyDesktopWindowRegion(hwnd)

	if err := bindDesktopWindowControls(window, hwnd); err != nil {
		return err
	}

	window.Init("window.__NPL_DESKTOP__ = true;")
	window.Navigate(target)
	window.Run()
	return nil
}

func bindDesktopWindowControls(window wv.WebView, hwnd uintptr) error {
	if err := window.Bind("nplWindowMinimize", func() {
		_, _, _ = showWindow.Call(hwnd, showMinimized)
	}); err != nil {
		return err
	}

	if err := window.Bind("nplWindowToggleMaximize", func() bool {
		if windowIsMaximized(hwnd) {
			_, _, _ = showWindow.Call(hwnd, showRestored)
			applyDesktopWindowRegion(hwnd)
			return false
		}
		_, _, _ = showWindow.Call(hwnd, showMaximized)
		applyDesktopWindowRegion(hwnd)
		return true
	}); err != nil {
		return err
	}

	// The page calls this on every resize: the region is window-sized,
	// so dragging an edge (or a snap shortcut) has to re-cut it.
	if err := window.Bind("nplWindowSyncRegion", func() {
		applyDesktopWindowRegion(hwnd)
	}); err != nil {
		return err
	}

	if err := window.Bind("nplWindowIsMaximized", func() bool {
		return windowIsMaximized(hwnd)
	}); err != nil {
		return err
	}

	if err := window.Bind("nplWindowStartDrag", func() {
		_, _, _ = releaseCapture.Call()
		_, _, _ = sendMessageW.Call(hwnd, windowMessageNCLButton, hitTestCaption, 0)
	}); err != nil {
		return err
	}

	if err := window.Bind("nplWindowClose", func() {
		_, _, _ = sendMessageW.Call(hwnd, windowMessageClose, 0, 0)
	}); err != nil {
		return err
	}

	return nil
}

func windowIsMaximized(hwnd uintptr) bool {
	zoomed, _, _ := isZoomed.Call(hwnd)
	return zoomed != 0
}

// The corner radius in CSS pixels. The topbar's border-top-right-radius
// and the round close button share this value, so the window's cut edge,
// the bar's arc and the circle's rim are one and the same curve.
const desktopCornerRadius = 24

type desktopWindowRect struct {
	left, top, right, bottom int32
}

// rgnOr merges regions in CombineRgn.
const rgnOr = 2

// applyDesktopWindowRegion cuts the frameless window so that only the
// top-right corner is rounded — the curve that wraps the close circle —
// while the other three corners stay square. Without a region the
// rounding only exists as a drawing inside a square window — the "two
// layers" look. Maximised windows revert to a plain rectangle so the
// app meets the screen edges.
func applyDesktopWindowRegion(hwnd uintptr) {
	if windowIsMaximized(hwnd) {
		_, _, _ = setWindowRgn.Call(hwnd, 0, 1)
		return
	}

	var rect desktopWindowRect
	if ok, _, _ := getWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); ok == 0 {
		return
	}

	width := uintptr(rect.right - rect.left)
	height := uintptr(rect.bottom - rect.top)

	dpi, _, _ := getDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	radius := uintptr(desktopCornerRadius) * dpi / 96
	diameter := radius * 2

	region, _, _ := createRoundRectRgn.Call(0, 0, width+1, height+1, diameter, diameter)
	if region == 0 {
		return
	}

	// Square off every corner but the top-right: OR the rounded shape
	// with the left side and with everything below the corner arc, so
	// only the top-right notch stays cut.
	if left, _, _ := createRectRgn.Call(0, 0, width-radius, height); left != 0 {
		_, _, _ = combineRgn.Call(region, region, left, rgnOr)
		_, _, _ = deleteObject.Call(left)
	}
	if below, _, _ := createRectRgn.Call(0, radius, width, height); below != 0 {
		_, _, _ = combineRgn.Call(region, region, below, rgnOr)
		_, _, _ = deleteObject.Call(below)
	}

	// The system owns the region once SetWindowRgn accepts it.
	_, _, _ = setWindowRgn.Call(hwnd, region, 1)
}

func applyDesktopWindowStyle(hwnd uintptr) {
	currentStyle, _, _ := getWindowLongPtrW.Call(hwnd, windowStyleIndex)
	_, _, _ = setWindowLongPtrW.Call(hwnd, windowStyleIndex, currentStyle&^windowStyleCaption)
	_, _, _ = setWindowPos.Call(
		hwnd,
		0,
		0,
		0,
		0,
		0,
		setPositionNoMove|setPositionNoSize|setPositionNoZOrder|setPositionFrameChanged,
	)

	darkMode := int32(1)
	cornerPreference := int32(dwmRoundWindow)
	captionColor := uint32(0x00180A03)
	textColor := uint32(0x00FFF2E9)
	borderColor := uint32(0x005A3217)

	_, _, _ = dwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmUseImmersiveDarkMode),
		uintptr(unsafe.Pointer(&darkMode)),
		unsafe.Sizeof(darkMode),
	)
	_, _, _ = dwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmWindowCornerPreference),
		uintptr(unsafe.Pointer(&cornerPreference)),
		unsafe.Sizeof(cornerPreference),
	)
	_, _, _ = dwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmCaptionColor),
		uintptr(unsafe.Pointer(&captionColor)),
		unsafe.Sizeof(captionColor),
	)
	_, _, _ = dwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmTextColor),
		uintptr(unsafe.Pointer(&textColor)),
		unsafe.Sizeof(textColor),
	)
	_, _, _ = dwmSetWindowAttribute.Call(
		hwnd,
		uintptr(dwmBorderColor),
		uintptr(unsafe.Pointer(&borderColor)),
		unsafe.Sizeof(borderColor),
	)
}

func showNativeError(title, message string) {
	titlePtr, _ := syscall.UTF16PtrFromString(title)
	messagePtr, _ := syscall.UTF16PtrFromString(message)
	_, _, _ = messageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(messagePtr)),
		uintptr(unsafe.Pointer(titlePtr)),
		uintptr(messageBoxOK|messageBoxIconError),
	)
}
