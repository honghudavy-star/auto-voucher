//go:build windows

package main

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

func freeDiskBytes(path string) (int64, error) {
	root := filepath.VolumeName(path) + `\`
	pointer, err := syscall.UTF16PtrFromString(root)
	if err != nil {
		return 0, err
	}
	var available, total, free uint64
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	procedure := kernel32.NewProc("GetDiskFreeSpaceExW")
	result, _, callErr := procedure.Call(
		uintptr(unsafe.Pointer(pointer)),
		uintptr(unsafe.Pointer(&available)),
		uintptr(unsafe.Pointer(&total)),
		uintptr(unsafe.Pointer(&free)),
	)
	if result == 0 {
		return 0, callErr
	}
	return int64(available), nil
}
