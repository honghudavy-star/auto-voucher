package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCompareVersions(t *testing.T) {
	if compareVersions("0.3.0", "0.2.9") <= 0 {
		t.Fatal("0.3.0 should be newer")
	}
	if compareVersions("v1.2.0", "1.2") != 0 {
		t.Fatal("equivalent versions should compare equally")
	}
}

func TestSupportsWindowsVersion(t *testing.T) {
	if supportsWindowsVersion(10, 19044) {
		t.Fatal("Windows 10 before 22H2 should be rejected")
	}
	if !supportsWindowsVersion(10, 19045) {
		t.Fatal("Windows 10 22H2 should be accepted")
	}
	if !supportsWindowsVersion(10, 26100) {
		t.Fatal("Windows 11 current builds should be accepted")
	}
	if !supportsWindowsVersion(11, 1) {
		t.Fatal("future Windows major versions should not be rejected solely by major number")
	}
}

func TestRolloutIsDeterministic(t *testing.T) {
	first := rolloutAllowed("device-1", 20)
	for index := 0; index < 20; index++ {
		if rolloutAllowed("device-1", 20) != first {
			t.Fatal("rollout assignment changed")
		}
	}
}

func TestSafeExtractRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	archivePath := filepath.Join(root, "unsafe.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	entry, err := writer.Create("../outside.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = entry.Write([]byte("unsafe"))
	_ = writer.Close()
	_ = file.Close()
	if err := safeExtractZip(archivePath, filepath.Join(root, "target")); err == nil {
		t.Fatal("path traversal should be rejected")
	}
}

func TestVerifyPackageRequiresMatchingHashAndSignature(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "core.zip")
	body := []byte("signed-core-package")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	publicKey := privateKey.Public().(ed25519.PublicKey)
	previousKey := manifestPublicKey
	manifestPublicKey = base64.StdEncoding.EncodeToString(publicKey)
	t.Cleanup(func() { manifestPublicKey = previousKey })
	digest := sha256.Sum256(body)
	pkg := Package{
		Size:      int64(len(body)),
		SHA256:    hex.EncodeToString(digest[:]),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:])),
	}
	if err := verifyPackage(path, pkg); err != nil {
		t.Fatalf("valid signed package was rejected: %v", err)
	}
	pkg.SHA256 = strings.Repeat("0", 64)
	if err := verifyPackage(path, pkg); err == nil {
		t.Fatal("mismatched package hash should be rejected")
	}
}

func TestValidateManifestRejectsUnsafeMetadata(t *testing.T) {
	manifest := validManifest()
	if err := validateManifest(manifest); err != nil {
		t.Fatalf("valid manifest was rejected: %v", err)
	}
	manifest.RolloutPercentage = 101
	if err := validateManifest(manifest); err == nil {
		t.Fatal("rollout above 100 should be rejected")
	}
	manifest = validManifest()
	manifest.Core.URL = "http://updates.example.test/core.zip"
	if err := validateManifest(manifest); err == nil {
		t.Fatal("non-HTTPS package URL should be rejected")
	}
	manifest = validManifest()
	manifest.MinimumVersion = "9.0.0"
	if err := validateManifest(manifest); err == nil {
		t.Fatal("minimum version above release version should be rejected")
	}
}

func TestFetchManifestRequiresValidSignatureAndChannel(t *testing.T) {
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{9}, ed25519.SeedSize))
	manifest := validManifest()
	body, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, body))
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasSuffix(request.URL.Path, ".sig") {
			_, _ = writer.Write([]byte(signature))
			return
		}
		_, _ = writer.Write(body)
	}))
	defer server.Close()

	previousKey := manifestPublicKey
	previousURL := defaultManifestURL
	previousLauncherVersion := launcherVersion
	manifestPublicKey = base64.StdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey))
	defaultManifestURL = server.URL + "/manifest.json"
	launcherVersion = "0.2.0"
	t.Cleanup(func() {
		manifestPublicKey = previousKey
		defaultManifestURL = previousURL
		launcherVersion = previousLauncherVersion
	})
	launcher := Launcher{
		client: server.Client(),
		state:  State{Channel: "stable"},
	}
	if _, err := launcher.fetchManifest(context.Background()); err != nil {
		t.Fatalf("signed manifest was rejected: %v", err)
	}
	launcher.state.Channel = "pilot"
	if _, err := launcher.fetchManifest(context.Background()); err == nil {
		t.Fatal("channel mismatch should be rejected")
	}
}

func TestDownloadPackageResumesAndVerifiesSignature(t *testing.T) {
	body := []byte("signed resumable release package")
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{5}, ed25519.SeedSize))
	digest := sha256.Sum256(body)
	requestedRange := ""
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requestedRange = request.Header.Get("Range")
		if requestedRange == "bytes=7-" {
			writer.WriteHeader(http.StatusPartialContent)
			_, _ = writer.Write(body[7:])
			return
		}
		_, _ = writer.Write(body)
	}))
	defer server.Close()

	previousKey := manifestPublicKey
	manifestPublicKey = base64.StdEncoding.EncodeToString(privateKey.Public().(ed25519.PublicKey))
	t.Cleanup(func() { manifestPublicKey = previousKey })
	root := t.TempDir()
	destination := filepath.Join(root, "core.zip.part")
	if err := os.WriteFile(destination, body[:7], 0o600); err != nil {
		t.Fatal(err)
	}
	launcher := Launcher{
		client: server.Client(),
		dirs:   Directories{StateFile: filepath.Join(root, "state.json")},
		state:  State{Status: "downloading"},
	}
	pkg := Package{
		URL:       server.URL + "/core.zip",
		Size:      int64(len(body)),
		SHA256:    hex.EncodeToString(digest[:]),
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, digest[:])),
	}
	if err := launcher.downloadPackage(context.Background(), pkg, destination); err != nil {
		t.Fatalf("resume failed: %v", err)
	}
	if requestedRange != "bytes=7-" {
		t.Fatalf("expected range resume, got %q", requestedRange)
	}
	actual, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, body) {
		t.Fatal("resumed package differs from source")
	}
}

func TestRestoreDatabaseBackupIsAtomicAndPreservesFailedDatabase(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	backups := filepath.Join(data, "backups")
	if err := os.MkdirAll(backups, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(data, "auto-voucher.sqlite3")
	if err := os.WriteFile(target, []byte("new-database"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+"-wal", []byte("new-wal"), 0o600); err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(backups, "pre-update.sqlite3")
	backupBody := []byte("old-database")
	if err := os.WriteFile(backup, backupBody, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(backupBody)
	launcher := Launcher{
		dirs: Directories{Data: data},
		state: State{
			PendingDatabaseBackup: backup,
			PendingDatabaseSHA256: hex.EncodeToString(digest[:]),
		},
	}
	if err := launcher.restoreDatabaseBackup(); err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	restored, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, backupBody) {
		t.Fatal("restored database does not match verified backup")
	}
	failed, err := filepath.Glob(filepath.Join(backups, "failed-update-*.sqlite3"))
	if err != nil || len(failed) != 1 {
		t.Fatalf("failed database was not preserved: %v %v", failed, err)
	}
	if _, err := os.Stat(failed[0] + "-wal"); err != nil {
		t.Fatal("failed WAL was not preserved")
	}
	if launcher.state.PendingDatabaseBackup != "" ||
		launcher.state.PendingDatabaseSHA256 != "" {
		t.Fatal("pending backup metadata should be cleared after restore")
	}
}

func TestRestoreDatabaseBackupRejectsPathOutsideBackupDirectory(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(data, "backups"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside.sqlite3")
	body := []byte("outside")
	if err := os.WriteFile(outside, body, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(body)
	launcher := Launcher{
		dirs: Directories{Data: data},
		state: State{
			PendingDatabaseBackup: outside,
			PendingDatabaseSHA256: hex.EncodeToString(digest[:]),
		},
	}
	if err := launcher.restoreDatabaseBackup(); err == nil {
		t.Fatal("backup outside controlled directory should be rejected")
	}
}

func TestRotateLogsRemovesExpiredFiles(t *testing.T) {
	root := t.TempDir()
	expired := filepath.Join(root, "launcher-expired.jsonl")
	if err := os.WriteFile(expired, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-31 * 24 * time.Hour)
	if err := os.Chtimes(expired, old, old); err != nil {
		t.Fatal(err)
	}
	if err := rotateLogs(root); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(expired); !os.IsNotExist(err) {
		t.Fatal("expired log should be removed")
	}
}

func validManifest() Manifest {
	digest := strings.Repeat("a", sha256.Size*2)
	signature := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, ed25519.SignatureSize))
	pkg := Package{
		URL:              "https://updates.example.test/core.zip",
		Size:             100,
		ExpandedSize:     200,
		SHA256:           digest,
		Signature:        signature,
		Entrypoint:       "AutoVoucherCore.exe",
		EntrypointSHA256: digest,
		DatabaseLevel:    2,
	}
	return Manifest{
		SchemaVersion:          1,
		Channel:                "stable",
		Version:                "0.2.0",
		MinimumVersion:         "0.2.0",
		MinimumLauncherVersion: "0.2.0",
		PublishedAt:            time.Now().UTC().Format(time.RFC3339),
		RolloutPercentage:      100,
		ReleaseNotes:           "test",
		Core:                   pkg,
		Components:             map[string]Package{},
	}
}
