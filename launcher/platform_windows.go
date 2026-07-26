//go:build windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

var launcherMutex syscall.Handle

func acquireSingleInstance() (bool, error) {
	name, err := syscall.UTF16PtrFromString(`Local\AutoVoucherLauncher`)
	if err != nil {
		return false, err
	}
	procedure := syscall.NewLazyDLL("kernel32.dll").NewProc("CreateMutexW")
	handle, _, callErr := procedure.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return false, callErr
	}
	launcherMutex = syscall.Handle(handle)
	const errorAlreadyExists syscall.Errno = 183
	return errors.Is(callErr, errorAlreadyExists), nil
}

type osVersionInfo struct {
	size           uint32
	major          uint32
	minor          uint32
	build          uint32
	platformID     uint32
	servicePack    [128]uint16
	servicePackMaj uint16
	servicePackMin uint16
	suiteMask      uint16
	productType    byte
	reserved       byte
}

func checkSupportedWindows() error {
	version := osVersionInfo{}
	version.size = uint32(unsafe.Sizeof(version))
	procedure := syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion")
	result, _, callErr := procedure.Call(uintptr(unsafe.Pointer(&version)))
	if result != 0 {
		return fmt.Errorf("无法读取 Windows 版本：%v", callErr)
	}
	if version.major != 10 || version.build < 19045 {
		return fmt.Errorf(
			"需要 Windows 10 22H2（内部版本 19045）或 Windows 11，当前内部版本为 %d",
			version.build,
		)
	}
	return nil
}
