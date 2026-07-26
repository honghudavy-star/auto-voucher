//go:build !windows

package main

import "errors"

func freeDiskBytes(_ string) (int64, error) {
	return 0, errors.New("unsupported platform")
}
