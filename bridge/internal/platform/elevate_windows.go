//go:build windows

package platform

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

type shellExecuteInfo struct {
	cbSize      uint32
	fMask       uint32
	hwnd        uintptr
	verb        *uint16
	file        *uint16
	parameters  *uint16
	directory   *uint16
	show        int32
	instApp     uintptr
	idList      uintptr
	class       *uint16
	keyClass    uintptr
	hotKey      uint32
	icon, hProc uintptr
}

func shellExecuteRunAs(file, params string) (int, error) {
	verb, _ := windows.UTF16PtrFromString("runas")
	f, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return 1, err
	}
	p, err := windows.UTF16PtrFromString(params)
	if err != nil {
		return 1, err
	}
	info := shellExecuteInfo{fMask: 0x40 /* SEE_MASK_NOCLOSEPROCESS */, verb: verb, file: f, parameters: p, show: windows.SW_HIDE}
	info.cbSize = uint32(unsafe.Sizeof(info))
	shell32 := windows.NewLazySystemDLL("shell32.dll")
	r, _, e := shell32.NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	if r == 0 {
		return 1, e // includes the user cancelling the UAC prompt (ERROR_CANCELLED)
	}
	h := windows.Handle(info.hProc)
	defer windows.CloseHandle(h)
	if _, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil {
		return 1, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return 1, err
	}
	return int(code), nil
}
