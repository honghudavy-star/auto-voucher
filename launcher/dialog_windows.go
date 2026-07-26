//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

func showErrorAndCopy(message string) {
	command := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		"Set-Clipboard -Value $env:AUTO_VOUCHER_ERROR",
	)
	command.Env = append(os.Environ(), "AUTO_VOUCHER_ERROR="+message)
	_ = command.Run()
	text, _ := syscall.UTF16PtrFromString(
		"Auto Voucher 无法启动。\n\n" + message +
			"\n\n问题信息已复制，可直接发给技术支持。",
	)
	title, _ := syscall.UTF16PtrFromString("Auto Voucher 启动失败")
	user32 := syscall.NewLazyDLL("user32.dll")
	messageBox := user32.NewProc("MessageBoxW")
	_, _, _ = messageBox.Call(
		0,
		uintptr(unsafe.Pointer(text)),
		uintptr(unsafe.Pointer(title)),
		0x10,
	)
}

func createShortcut() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	command := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$shell=New-Object -ComObject WScript.Shell;`+
			`$shortcut=$shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Auto Voucher.lnk'));`+
			`$shortcut.TargetPath=$env:AUTO_VOUCHER_LAUNCHER;`+
			`$shortcut.WorkingDirectory=(Split-Path $env:AUTO_VOUCHER_LAUNCHER);`+
			`$shortcut.Save()`,
	)
	command.Env = append(os.Environ(), "AUTO_VOUCHER_LAUNCHER="+executable)
	return command.Run()
}
