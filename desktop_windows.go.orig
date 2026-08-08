//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
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
	setForegroundWindow   = user32.NewProc("SetForegroundWindow")
	loadIconW             = user32.NewProc("LoadIconW")
	kernel32Icon          = syscall.NewLazyDLL("kernel32.dll")
	getModuleHandleW      = kernel32Icon.NewProc("GetModuleHandleW")
	monitorFromWindow     = user32.NewProc("MonitorFromWindow")
	getMonitorInfoW       = user32.NewProc("GetMonitorInfoW")
	getDpiForWindow       = user32.NewProc("GetDpiForWindow")
	ole32                 = syscall.NewLazyDLL("ole32.dll")
	coInitializeEx        = ole32.NewProc("CoInitializeEx")
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
	window.Run()
	return nil
}

const roomClockWindowTitle = "NPL Room Clock"

const monitorDefaultToNearest = 2

type winRect struct {
	left, top, right, bottom int32
}

type winMonitorInfo struct {
	cbSize    uint32
	rcMonitor winRect
	rcWork    winRect
	dwFlags   uint32
}

var (
	roomClockMu   sync.Mutex
	roomClockOpen = map[string]uintptr{}
)

// openRoomClockWindow hosts the room clock in a window this process
// owns. A window.open popup belongs to the WebView2 browser process —
// its system caption and URL strip cannot be restyled from here — so
// the desk asks the host, and the host builds a chrome-less window
// instead. Each clock runs its own message loop on its own locked
// thread; asking for a clock that is already open just refocuses it.
func openRoomClockWindow(target string) {
	roomClockMu.Lock()
	if hwnd, ok := roomClockOpen[target]; ok {
		roomClockMu.Unlock()
		_, _, _ = showWindow.Call(hwnd, showRestored)
		_, _, _ = setForegroundWindow.Call(hwnd)
		return
	}
	roomClockMu.Unlock()

	go func() {
		runtime.LockOSThread()
		// The webview library initialises COM for the main thread only;
		// this thread hosts its own window and message loop.
		_, _, _ = coInitializeEx.Call(0, 2)

		clock := wv.NewWithOptions(wv.WebViewOptions{
			Debug:     false,
			DataPath:  filepath.Join(os.Getenv("LOCALAPPDATA"), "NPLPoker", "OperationalSystem", "WebView2"),
			AutoFocus: true,
			WindowOptions: wv.WindowOptions{
				Title:  roomClockWindowTitle,
				Width:  420,
				Height: 560,
				Center: true,
			},
		})
		if clock == nil {
			return
		}

		hwnd := uintptr(clock.Window())
		applyDesktopWindowStyle(hwnd)
		clock.SetSize(320, 400, wv.HintMin)
		// The clock arrives as the mini widget — the page defaults to the
		// mini layout to match — and grows to the projector on demand.
		layoutRoomClockWindow(hwnd, "mini")
		bindRoomClockWindow(clock, hwnd)

		roomClockMu.Lock()
		roomClockOpen[target] = hwnd
		roomClockMu.Unlock()

		clock.Navigate(target)
		clock.Run()

		roomClockMu.Lock()
		delete(roomClockOpen, target)
		roomClockMu.Unlock()
	}()
}

func bindRoomClockWindow(window wv.WebView, hwnd uintptr) {
	_ = window.Bind("nplWindowMinimize", func() {
		_, _, _ = showWindow.Call(hwnd, showMinimized)
	})

	_ = window.Bind("nplWindowClose", func() {
		_, _, _ = sendMessageW.Call(hwnd, windowMessageClose, 0, 0)
	})

	_ = window.Bind("nplWindowStartDrag", func() {
		_, _, _ = releaseCapture.Call()
		_, _, _ = sendMessageW.Call(hwnd, windowMessageNCLButton, hitTestCaption, 0)
	})

	// The square button drives the window with the layout.
	_ = window.Bind("nplClockLayout", func(mode string) {
		layoutRoomClockWindow(hwnd, mode)
	})
}

// layoutRoomClockWindow sizes the clock window for a layout: "max"
// covers the monitor edge to edge, "mini" is the small clock widget
// centred on whichever monitor the window lives on.
func layoutRoomClockWindow(hwnd uintptr, mode string) {
	var info winMonitorInfo
	info.cbSize = uint32(unsafe.Sizeof(info))
	haveMonitor := false
	if monitor, _, _ := monitorFromWindow.Call(hwnd, monitorDefaultToNearest); monitor != 0 {
		ok, _, _ := getMonitorInfoW.Call(monitor, uintptr(unsafe.Pointer(&info)))
		haveMonitor = ok != 0
	}

	if mode == "max" {
		if !haveMonitor {
			_, _, _ = showWindow.Call(hwnd, showMaximized)
			return
		}
		_, _, _ = setWindowPos.Call(
			hwnd,
			0,
			uintptr(int(info.rcMonitor.left)),
			uintptr(int(info.rcMonitor.top)),
			uintptr(int(info.rcMonitor.right-info.rcMonitor.left)),
			uintptr(int(info.rcMonitor.bottom-info.rcMonitor.top)),
			setPositionNoZOrder|setPositionFrameChanged,
		)
		return
	}

	dpi, _, _ := getDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	width := int(420 * dpi / 96)
	height := int(560 * dpi / 96)

	if !haveMonitor {
		_, _, _ = setWindowPos.Call(hwnd, 0, 0, 0, uintptr(width), uintptr(height), setPositionNoMove|setPositionNoZOrder|setPositionFrameChanged)
		return
	}

	left := int(info.rcWork.left) + (int(info.rcWork.right-info.rcWork.left)-width)/2
	top := int(info.rcWork.top) + (int(info.rcWork.bottom-info.rcWork.top)-height)/2
	_, _, _ = setWindowPos.Call(hwnd, 0, uintptr(left), uintptr(top), uintptr(width), uintptr(height), setPositionNoZOrder|setPositionFrameChanged)
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

	// The desk cannot use window.open for the room clock — that popup
	// would belong to the browser process, stock chrome and all.
	if err := window.Bind("nplOpenRoomClock", func(target string) {
		openRoomClockWindow(target)
	}); err != nil {
		return err
	}

	return nil
}

func windowIsMaximized(hwnd uintptr) bool {
	zoomed, _, _ := isZoomed.Call(hwnd)
	return zoomed != 0
}

// applyWindowIcon stamps the exe's embedded NPL icon (winres group "APP")
// onto a window, so host-built windows — the room clock included — carry
// the same logo as the executable in the taskbar and switcher.
func applyWindowIcon(hwnd uintptr) {
	hInstance, _, _ := getModuleHandleW.Call(0)
	name, err := syscall.UTF16PtrFromString("APP")
	if err != nil {
		return
	}

	icon, _, _ := loadIconW.Call(hInstance, uintptr(unsafe.Pointer(name)))
	if icon == 0 {
		return
	}

	const windowMessageSetIcon = 0x0080
	_, _, _ = sendMessageW.Call(hwnd, windowMessageSetIcon, 0, icon) // ICON_SMALL
	_, _, _ = sendMessageW.Call(hwnd, windowMessageSetIcon, 1, icon) // ICON_BIG
}

func applyDesktopWindowStyle(hwnd uintptr) {
	applyWindowIcon(hwnd)
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
