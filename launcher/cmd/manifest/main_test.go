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
	if err := validateReleaseMetadata("0.2.0", "stable", "0.2.0", "0.2.0", 100, 2); err != nil {
		t.Fatalf("valid release metadata was rejected: %v", err)
	}
	for _, test := range []struct {
		name                      string
		version, channel, minimum string
		minimumLauncher           string
		rollout, databaseVersion  int
	}{
		{"invalid channel", "0.2.0", "beta", "0.2.0", "0.2.0", 5, 2},
		{"invalid version", "latest", "stable", "0.2.0", "0.2.0", 5, 2},
		{"invalid rollout", "0.2.0", "stable", "0.2.0", "0.2.0", 101, 2},
		{"invalid database", "0.2.0", "stable", "0.2.0", "0.2.0", 5, 0},
		{"minimum above release", "0.2.0", "stable", "0.3.0", "0.2.0", 5, 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := validateReleaseMetadata(
				test.version,
				test.channel,
				test.minimum,
				test.minimumLauncher,
				test.rollout,
				test.databaseVersion,
			); err == nil {
				t.Fatal("invalid release metadata should be rejected")
			}
		})
	}
}

func TestPackageInfoRequiresHTTPSAndHashesEntrypoint(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "core.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create("AutoVoucherCore.exe")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte("core"))
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
	if pkg.Size <= 0 || pkg.ExpandedSize != 4 || pkg.EntrypointSHA256 == "" {
		t.Fatalf("unexpected package metadata: %+v", pkg)
	}
}
