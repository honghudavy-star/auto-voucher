//go:build !windows

package main

func checkSupportedWindows() error {
	return nil
}

func acquireSingleInstance() (bool, error) {
	return false, nil
}
