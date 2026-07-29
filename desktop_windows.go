//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"
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
	findWindowExW         = user32.NewProc("FindWindowExW")
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

	if err := bindDesktopWindowControls(window, hwnd); err != nil {
		return err
	}

	window.Init("window.__NPL_DESKTOP__ = true;")
	window.Navigate(target)
	watchRoomClockWindows()
	window.Run()
	return nil
}

// The room-clock page titles itself exactly this — keep in sync with
// TimerDisplay.tsx.
const roomClockWindowTitle = "NPL Room Clock"

// watchRoomClockWindows re-frames room-clock popups. WebView2 opens
// window.open windows with the stock system caption; the page draws its
// own title bar, so the system one comes off — same treatment as the
// main window, found by the popup's fixed title.
func watchRoomClockWindows() {
	titlePtr, err := syscall.UTF16PtrFromString(roomClockWindowTitle)
	if err != nil {
		return
	}

	go func() {
		for {
			var hwnd uintptr
			for {
				found, _, _ := findWindowExW.Call(0, hwnd, 0, uintptr(unsafe.Pointer(titlePtr)))
				if found == 0 {
					break
				}
				hwnd = found

				style, _, _ := getWindowLongPtrW.Call(hwnd, windowStyleIndex)
				if style&windowStyleCaption != 0 {
					applyDesktopWindowStyle(hwnd)
				}
			}
			time.Sleep(700 * time.Millisecond)
		}
	}()
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
			return false
		}
		_, _, _ = showWindow.Call(hwnd, showMaximized)
		return true
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
