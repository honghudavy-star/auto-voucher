package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateReleaseMetadata(t *testing.T) {
	if err := validateReleaseMetadata("0.2.0", "0.2.0", "0.2.0", 2); err != nil {
		t.Fatalf("valid release metadata was rejected: %v", err)
	}
	for _, test := range []struct {
		name             string
		version, minimum string
		minimumLauncher  string
		databaseVersion  int
	}{
		{"invalid version", "latest", "0.2.0", "0.2.0", 2},
		{"invalid database", "0.2.0", "0.2.0", "0.2.0", 0},
		{"minimum above release", "0.2.0", "0.3.0", "0.2.0", 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateReleaseMetadata(
				test.version,
				test.minimum,
				test.minimumLauncher,
				test.databaseVersion,
			); err == nil {
				t.Fatal("invalid release metadata should be rejected")
			}
		})
	}
}

func TestPackageInfoRequiresCompleteApplicationBundle(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "application.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for name, body := range map[string]string{
		"AutoVoucherCore.exe": "core",
		"AutoVoucherOCR.exe":  "ocr",
		"AutoVoucherPDF.exe":  "pdf",
	} {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		_, _ = entry.Write([]byte(body))
	}
	_ = writer.Close()
	_ = file.Close()
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, ed25519.SeedSize))

	if _, err := packageInfo(
		archivePath,
		"http://updates.example.test/core.zip",
		"AutoVoucherCore.exe",
		2,
		key,
	); err == nil {
		t.Fatal("non-HTTPS URL should be rejected")
	}
	pkg, err := packageInfo(
		archivePath,
		"https://updates.example.test/core.zip",
		"AutoVoucherCore.exe",
		2,
		key,
	)
	if err != nil {
		t.Fatalf("valid package was rejected: %v", err)
	}
	if pkg.Size <= 0 || pkg.ExpandedSize != 10 || pkg.EntrypointSHA256 == "" {
		t.Fatalf("unexpected package metadata: %+v", pkg)
	}
}

func TestPackageInfoRejectsMissingBundledWorker(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "incomplete.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, name := range []string{"AutoVoucherCore.exe", "AutoVoucherOCR.exe"} {
		entry, createErr := writer.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		_, _ = entry.Write([]byte(name))
	}
	_ = writer.Close()
	_ = file.Close()
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{3}, ed25519.SeedSize))

	if _, err := packageInfo(
		archivePath,
		"https://updates.example.test/application.zip",
		"AutoVoucherCore.exe",
		2,
		key,
	); err == nil {
		t.Fatal("application bundle without PDF worker should be rejected")
	}
}
