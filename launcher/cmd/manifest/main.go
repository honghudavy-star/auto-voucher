package main

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Package struct {
	URL              string `json:"url"`
	Size             int64  `json:"size"`
	ExpandedSize     int64  `json:"expandedSize"`
	SHA256           string `json:"sha256"`
	Signature        string `json:"signature"`
	Entrypoint       string `json:"entrypoint"`
	EntrypointSHA256 string `json:"entrypointSha256"`
	DatabaseLevel    int    `json:"databaseVersion"`
}

type Manifest struct {
	SchemaVersion          int                `json:"schemaVersion"`
	Channel                string             `json:"channel"`
	Version                string             `json:"version"`
	MinimumVersion         string             `json:"minimumVersion"`
	MinimumLauncherVersion string             `json:"minimumLauncherVersion"`
	PublishedAt            string             `json:"publishedAt"`
	RolloutPercentage      int                `json:"rolloutPercentage"`
	ReleaseNotes           string             `json:"releaseNotes"`
	Core                   Package            `json:"core"`
	Components             map[string]Package `json:"components"`
}

func main() {
	var (
		version                = flag.String("version", "", "release version")
		application            = flag.String("application", "", "complete application zip")
		applicationURL         = flag.String("application-url", "", "HTTPS application URL")
		output                 = flag.String("output", "release/manifest.json", "manifest output")
		notes                  = flag.String("notes", "", "release notes")
		minimumVersion         = flag.String("minimum-version", "0.2.0", "minimum allowed core version")
		minimumLauncherVersion = flag.String("minimum-launcher-version", "0.2.0", "minimum launcher version")
		databaseVersion        = flag.Int("database-version", 2, "compatible database schema version")
	)
	flag.Parse()
	must(validateReleaseMetadata(
		*version,
		*minimumVersion,
		*minimumLauncherVersion,
		*databaseVersion,
	))
	encodedKey := os.Getenv("AUTO_VOUCHER_RELEASE_PRIVATE_KEY")
	if keyFile := os.Getenv("AUTO_VOUCHER_RELEASE_PRIVATE_KEY_FILE"); keyFile != "" {
		body, readErr := os.ReadFile(keyFile)
		must(readErr)
		encodedKey = string(body)
	}
	privateKey, err := signingKey(encodedKey)
	must(err)
	applicationPackage, err := packageInfo(
		*application,
		*applicationURL,
		"AutoVoucherCore.exe",
		*databaseVersion,
		privateKey,
	)
	must(err)
	manifest := Manifest{
		SchemaVersion:          1,
		Channel:                "stable",
		Version:                *version,
		MinimumVersion:         *minimumVersion,
		MinimumLauncherVersion: *minimumLauncherVersion,
		PublishedAt:            time.Now().UTC().Format(time.RFC3339),
		// These two fields remain in schema v1 only so installed 0.2.x
		// launchers can consume the new single application bundle.
		RolloutPercentage: 100,
		ReleaseNotes:      *notes,
		Core:              applicationPackage,
		Components:        map[string]Package{},
	}
	payload, err := json.MarshalIndent(manifest, "", "  ")
	must(err)
	must(os.MkdirAll(filepath.Dir(*output), 0o755))
	must(os.WriteFile(*output, payload, 0o644))
	signature := ed25519.Sign(privateKey, payload)
	must(os.WriteFile(*output+".sig", []byte(base64.StdEncoding.EncodeToString(signature)+"\n"), 0o644))
}

func packageInfo(
	path, url, entrypoint string,
	databaseVersion int,
	key ed25519.PrivateKey,
) (Package, error) {
	if path == "" || url == "" {
		return Package{}, fmt.Errorf("package path and URL are required")
	}
	if !strings.HasPrefix(url, "https://") {
		return Package{}, fmt.Errorf("package URL must use HTTPS")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return Package{}, err
	}
	digest := sha256.Sum256(body)
	expanded, err := expandedSize(path)
	if err != nil {
		return Package{}, err
	}
	entrypointDigest, err := zipEntrypointDigest(path, entrypoint)
	if err != nil {
		return Package{}, err
	}
	for _, bundledEntrypoint := range []string{"AutoVoucherOCR.exe", "AutoVoucherPDF.exe"} {
		if _, err := zipEntrypointDigest(path, bundledEntrypoint); err != nil {
			return Package{}, fmt.Errorf("complete application package: %w", err)
		}
	}
	return Package{
		URL:              url,
		Size:             int64(len(body)),
		ExpandedSize:     expanded,
		SHA256:           hex.EncodeToString(digest[:]),
		Signature:        base64.StdEncoding.EncodeToString(ed25519.Sign(key, digest[:])),
		Entrypoint:       entrypoint,
		EntrypointSHA256: entrypointDigest,
		DatabaseLevel:    databaseVersion,
	}, nil
}

var versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)

func validateReleaseMetadata(
	version, minimumVersion, minimumLauncherVersion string,
	databaseVersion int,
) error {
	for name, value := range map[string]string{
		"version":                  version,
		"minimum-version":          minimumVersion,
		"minimum-launcher-version": minimumLauncherVersion,
	} {
		if !versionPattern.MatchString(value) {
			return fmt.Errorf("%s must be a semantic version", name)
		}
	}
	if compareReleaseVersions(minimumVersion, version) > 0 {
		return fmt.Errorf("minimum-version cannot be newer than version")
	}
	if compareReleaseVersions(minimumLauncherVersion, version) > 0 {
		return fmt.Errorf("minimum-launcher-version cannot be newer than version")
	}
	if databaseVersion <= 0 {
		return fmt.Errorf("database-version must be positive")
	}
	return nil
}

func compareReleaseVersions(left, right string) int {
	leftParts := strings.Split(strings.SplitN(left, "-", 2)[0], ".")
	rightParts := strings.Split(strings.SplitN(right, "-", 2)[0], ".")
	for index := 0; index < 3; index++ {
		leftValue, _ := strconv.Atoi(leftParts[index])
		rightValue, _ := strconv.Atoi(rightParts[index])
		if leftValue < rightValue {
			return -1
		}
		if leftValue > rightValue {
			return 1
		}
	}
	return 0
}

func zipEntrypointDigest(path, entrypoint string) (string, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return "", err
	}
	defer archive.Close()
	for _, entry := range archive.File {
		if filepath.Base(entry.Name) != entrypoint || entry.FileInfo().IsDir() {
			continue
		}
		input, openErr := entry.Open()
		if openErr != nil {
			return "", openErr
		}
		hash := sha256.New()
		_, copyErr := io.Copy(hash, input)
		closeErr := input.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		return hex.EncodeToString(hash.Sum(nil)), nil
	}
	return "", fmt.Errorf("entrypoint %s not found in package", entrypoint)
}

func expandedSize(path string) (int64, error) {
	archive, err := zip.OpenReader(path)
	if err != nil {
		return 0, err
	}
	defer archive.Close()
	var total int64
	for _, entry := range archive.File {
		total += int64(entry.UncompressedSize64)
	}
	return total, nil
}

func signingKey(encoded string) (ed25519.PrivateKey, error) {
	value, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	if len(value) == ed25519.SeedSize {
		return ed25519.NewKeyFromSeed(value), nil
	}
	if len(value) == ed25519.PrivateKeySize {
		return ed25519.PrivateKey(value), nil
	}
	return nil, fmt.Errorf("release private key must be a 32-byte seed or 64-byte private key")
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
