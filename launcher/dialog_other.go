//go:build !windows

package main

import "fmt"

func showErrorAndCopy(message string) {
	fmt.Println(message)
}

func createShortcut() error {
	return fmt.Errorf("unsupported platform")
}
