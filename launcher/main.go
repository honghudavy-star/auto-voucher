package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	launcherVersion    = "0.1.0-dev"
	defaultManifestURL = ""
	releaseContract    = "0.1.0-dev|"
	manifestPublicKey  = ""
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
	SchemaVersion          int     `json:"schemaVersion"`
	Channel                string  `json:"channel"`
	Version                string  `json:"version"`
	MinimumVersion         string  `json:"minimumVersion"`
	MinimumLauncherVersion string  `json:"minimumLauncherVersion"`
	PublishedAt            string  `json:"publishedAt"`
	ReleaseNotes           string  `json:"releaseNotes"`
	Core                   Package `json:"core"`
}

type State struct {
	Channel                 string `json:"channel"`
	CurrentVersion          string `json:"currentVersion"`
	PreviousVersion         string `json:"previousVersion"`
	AvailableVersion        string `json:"availableVersion"`
	PendingVersion          string `json:"pendingVersion"`
	Status                  string `json:"status"`
	Message                 string `json:"message"`
	Progress                int    `json:"progress"`
	ReleaseNotes            string `json:"releaseNotes"`
	CorePort                int    `json:"corePort"`
	ControlPort             int    `json:"controlPort"`
	LastCheckedAt           string `json:"lastCheckedAt"`
	PostponedUntil          string `json:"postponedUntil"`
	LastSupportCode         string `json:"lastSupportCode"`
	CoreSHA256              string `json:"coreSha256"`
	PreviousCoreSHA256      string `json:"previousCoreSha256"`
	PendingCoreSHA256       string `json:"pendingCoreSha256"`
	CurrentDatabaseVersion  int    `json:"currentDatabaseVersion"`
	PreviousDatabaseVersion int    `json:"previousDatabaseVersion"`
	PendingDatabaseVersion  int    `json:"pendingDatabaseVersion"`
	PendingDatabaseBackup   string `json:"pendingDatabaseBackup"`
	PendingDatabaseSHA256   string `json:"pendingDatabaseSha256"`
}

type Directories struct {
	Root, Versions, Cache, Logs, Data, StateFile string
}

type Launcher struct {
	mu         sync.Mutex
	downloadMu sync.Mutex
	dirs       Directories
	state      State
	manifest   *Manifest
	token      string
	core       *exec.Cmd
	client     *http.Client
}

func main() {
	if runtime.GOOS != "windows" {
		failUser("当前启动器只支持 Windows 10 22H2 或 Windows 11 x64。", nil)
	}
	if runtime.GOARCH != "amd64" {
		failUser("当前启动器首期只支持 Windows x64，不支持 ARM64。", nil)
	}
	if err := validateReleaseContract(); err != nil {
		failUser("启动器发布元数据无效。", err)
	}
	if err := checkSupportedWindows(); err != nil {
		failUser("当前 Windows 版本不受支持。", err)
	}
	dirs, err := directories()
	if err != nil {
		failUser("无法创建 Auto Voucher 程序目录。", err)
	}
	alreadyRunning, err := acquireSingleInstance()
	if err != nil {
		failUser("无法建立启动器单实例保护。", err)
	}
	if alreadyRunning {
		if waitForExistingInstance(dirs.StateFile, 90*time.Second) {
			return
		}
		failUser("Auto Voucher 正在首次安装或启动，请稍后再次双击。", nil)
	}
	launcher := &Launcher{
		dirs: dirs,
		client: &http.Client{
			Timeout: 30 * time.Second,
			CheckRedirect: func(request *http.Request, _ []*http.Request) error {
				if request.URL.Scheme != "https" {
					return errors.New("更新下载不允许重定向到非 HTTPS 地址")
				}
				return nil
			},
		},
		token: randomToken(),
	}
	launcher.state, err = loadState(dirs.StateFile)
	if err != nil {
		failUser("启动器状态文件损坏。", err)
	}
	// Auto Voucher now has one public update stream. This also migrates
	// historical pilot state written by earlier launchers.
	launcher.state.Channel = "stable"
	if launcher.openExisting() {
		return
	}
	if err := launcher.ensureInstalled(); err != nil {
		launcher.log("ERROR", "FIRST_RUN_FAILED", err.Error(), nil)
		failUser("首次安装或版本校验失败。", err)
	}
	controlURL, err := launcher.startControlServer()
	if err != nil {
		launcher.log("ERROR", "CONTROL_SERVER_FAILED", err.Error(), nil)
		failUser("无法启动本地更新控制服务。", err)
	}
	if err := launcher.startCore(controlURL); err != nil {
		if rollbackErr := launcher.rollback(controlURL); rollbackErr != nil {
			launcher.log("ERROR", "START_AND_ROLLBACK_FAILED", errors.Join(err, rollbackErr).Error(), nil)
			failUser("核心程序启动失败，且无法恢复上一版本。", errors.Join(err, rollbackErr))
		}
	}
	openBrowser(fmt.Sprintf("http://127.0.0.1:%d", launcher.state.CorePort))
	go launcher.checkForUpdate(context.Background())
	go launcher.autoUpdateLoop()
	_ = launcher.save()
	select {}
}

func directories() (Directories, error) {
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		return Directories{}, errors.New("LOCALAPPDATA 未设置")
	}
	root := filepath.Join(local, "Auto Voucher")
	dirs := Directories{
		Root:      root,
		Versions:  filepath.Join(root, "app", "versions"),
		Cache:     filepath.Join(root, "cache"),
		Logs:      filepath.Join(root, "logs"),
		Data:      filepath.Join(root, "data"),
		StateFile: filepath.Join(root, "app", "launcher-state.json"),
	}
	for _, path := range []string{dirs.Versions, dirs.Cache, dirs.Logs, dirs.Data, filepath.Dir(dirs.StateFile)} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return Directories{}, err
		}
	}
	return dirs, nil
}

func loadState(path string) (State, error) {
	payload, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{Status: "idle"}, nil
	}
	if err != nil {
		return State{}, err
	}
	var state State
	if err := json.Unmarshal(payload, &state); err != nil {
		return State{}, err
	}
	return state, nil
}

func waitForExistingInstance(stateFile string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		state, err := loadState(stateFile)
		if err == nil && state.CorePort > 0 &&
			waitForHealth(state.CorePort, 800*time.Millisecond, "", 0) == nil {
			openBrowser(fmt.Sprintf("http://127.0.0.1:%d", state.CorePort))
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return false
}

func (l *Launcher) save() error {
	payload, err := json.MarshalIndent(l.state, "", "  ")
	if err != nil {
		return err
	}
	temporary := l.dirs.StateFile + ".tmp"
	if err := os.WriteFile(temporary, payload, 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, l.dirs.StateFile)
}

func (l *Launcher) manifestURL() string {
	if value := strings.TrimSpace(os.Getenv("AUTO_VOUCHER_UPDATE_MANIFEST_URL")); value != "" {
		return value
	}
	return strings.TrimSpace(defaultManifestURL)
}

func validateReleaseContract() error {
	expected := strings.Join([]string{
		strings.TrimSpace(launcherVersion),
		strings.TrimSpace(defaultManifestURL),
	}, "|")
	if releaseContract != expected {
		return fmt.Errorf("启动器发布元数据不一致")
	}
	manifestURL, err := url.Parse(strings.TrimSpace(defaultManifestURL))
	if err != nil || manifestURL.Scheme != "https" || !strings.HasSuffix(manifestURL.Path, "/stable/manifest.json") {
		return errors.New("启动器必须使用 stable HTTPS 更新清单")
	}
	return nil
}

func (l *Launcher) fetchManifest(ctx context.Context) (*Manifest, error) {
	url := l.manifestURL()
	if !strings.HasPrefix(url, "https://") {
		return nil, errors.New("正式更新清单必须使用 HTTPS")
	}
	body, err := l.get(ctx, url)
	if err != nil {
		return nil, err
	}
	signature, err := l.get(ctx, url+".sig")
	if err != nil {
		return nil, fmt.Errorf("下载清单签名: %w", err)
	}
	if err := verifySignature(body, bytes.TrimSpace(signature), manifestPublicKey); err != nil {
		return nil, fmt.Errorf("版本清单签名无效: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		return nil, err
	}
	if err := validateManifest(manifest); err != nil {
		return nil, err
	}
	if compareVersions(launcherVersion, manifest.MinimumLauncherVersion) < 0 {
		return nil, fmt.Errorf("启动器需要先升级到 %s", manifest.MinimumLauncherVersion)
	}
	return &manifest, nil
}

var releaseVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)

func validateManifest(manifest Manifest) error {
	if manifest.SchemaVersion != 1 {
		return fmt.Errorf("不支持的版本清单结构 v%d", manifest.SchemaVersion)
	}
	if manifest.Channel != "stable" {
		return errors.New("版本清单必须属于 stable 更新流")
	}
	for name, value := range map[string]string{
		"version":                manifest.Version,
		"minimumVersion":         manifest.MinimumVersion,
		"minimumLauncherVersion": manifest.MinimumLauncherVersion,
	} {
		if !releaseVersionPattern.MatchString(value) {
			return fmt.Errorf("%s 不是有效版本号", name)
		}
	}
	if compareVersions(manifest.MinimumVersion, manifest.Version) > 0 {
		return errors.New("minimumVersion 不能高于发布版本")
	}
	if _, err := time.Parse(time.RFC3339, manifest.PublishedAt); err != nil {
		return errors.New("publishedAt 必须为 RFC3339 时间")
	}
	if err := validatePackageDescriptor("application", manifest.Core); err != nil {
		return err
	}
	return nil
}

func validatePackageDescriptor(name string, pkg Package) error {
	if !strings.HasPrefix(pkg.URL, "https://") {
		return fmt.Errorf("%s 程序包必须使用 HTTPS", name)
	}
	if pkg.Size <= 0 || pkg.ExpandedSize <= 0 {
		return fmt.Errorf("%s 程序包大小无效", name)
	}
	if len(pkg.SHA256) != sha256.Size*2 || len(pkg.EntrypointSHA256) != sha256.Size*2 {
		return fmt.Errorf("%s 程序包 SHA-256 格式无效", name)
	}
	if _, err := hex.DecodeString(pkg.SHA256); err != nil {
		return fmt.Errorf("%s 程序包 SHA-256 格式无效", name)
	}
	if _, err := hex.DecodeString(pkg.EntrypointSHA256); err != nil {
		return fmt.Errorf("%s 入口文件 SHA-256 格式无效", name)
	}
	signature, err := base64.StdEncoding.DecodeString(pkg.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return fmt.Errorf("%s 程序包签名格式无效", name)
	}
	if filepath.Base(pkg.Entrypoint) != pkg.Entrypoint || !strings.HasSuffix(pkg.Entrypoint, ".exe") {
		return fmt.Errorf("%s 入口文件名无效", name)
	}
	if pkg.DatabaseLevel <= 0 {
		return fmt.Errorf("%s 数据库兼容版本无效", name)
	}
	return nil
}

func (l *Launcher) get(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	response, err := l.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, 10<<20))
}

func verifySignature(payload, encodedSignature []byte, encodedPublicKey string) error {
	publicKey, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encodedPublicKey))
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("启动器未内置有效发布公钥")
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(encodedSignature)))
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("签名格式无效")
	}
	if !ed25519.Verify(ed25519.PublicKey(publicKey), payload, signature) {
		return errors.New("签名验证失败")
	}
	return nil
}

func (l *Launcher) ensureInstalled() error {
	if l.state.CurrentVersion != "" && l.corePath(l.state.CurrentVersion) != "" {
		return nil
	}
	if err := l.preflightLocal(); err != nil {
		return err
	}
	manifest, err := l.fetchManifest(context.Background())
	if err != nil {
		return err
	}
	l.manifest = manifest
	if err := l.install(manifest); err != nil {
		return err
	}
	l.state.CurrentVersion = manifest.Version
	l.state.CoreSHA256 = l.state.PendingCoreSHA256
	l.state.CurrentDatabaseVersion = l.state.PendingDatabaseVersion
	l.state.PendingCoreSHA256 = ""
	l.state.PendingDatabaseVersion = 0
	l.state.Status = "idle"
	l.state.Message = "首次安装完成"
	return l.save()
}

func (l *Launcher) preflightLocal() error {
	for _, directory := range []string{l.dirs.Data, l.dirs.Cache, os.TempDir()} {
		source := filepath.Join(directory, ".auto-voucher-environment.tmp")
		target := source + ".checked"
		if err := os.WriteFile(source, []byte("ok"), 0o600); err != nil {
			return fmt.Errorf("目录不可写 %s: %w", directory, err)
		}
		if err := os.Rename(source, target); err != nil {
			_ = os.Remove(source)
			return fmt.Errorf("目录不支持原子重命名 %s: %w", directory, err)
		}
		_ = os.Remove(target)
	}
	if _, err := findPort(); err != nil {
		return err
	}
	return nil
}

func (l *Launcher) install(manifest *Manifest) error {
	var databaseBackupBytes int64
	if info, err := os.Stat(filepath.Join(l.dirs.Data, "auto-voucher.sqlite3")); err == nil {
		databaseBackupBytes = info.Size() * 12 / 10
	}
	required := manifest.Core.Size + manifest.Core.ExpandedSize + databaseBackupBytes + 512<<20
	if free, err := freeDiskBytes(l.dirs.Root); err == nil && free < required {
		return fmt.Errorf("磁盘空间不足：需要 %d bytes，可用 %d bytes", required, free)
	}
	archive := filepath.Join(l.dirs.Cache, "application-"+manifest.Version+".zip.part")
	l.state.Status = "downloading"
	l.state.Progress = 0
	_ = l.save()
	if err := l.downloadPackage(context.Background(), manifest.Core, archive); err != nil {
		return err
	}
	target := filepath.Join(l.dirs.Versions, manifest.Version)
	staging := target + ".staging"
	_ = os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return err
	}
	if err := verifyExpandedSize(archive, manifest.Core.ExpandedSize); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := safeExtractZip(archive, staging); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := verifyFileHash(
		filepath.Join(staging, manifest.Core.Entrypoint),
		manifest.Core.EntrypointSHA256,
	); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.RemoveAll(target); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	if err := os.Rename(staging, target); err != nil {
		_ = os.RemoveAll(staging)
		return err
	}
	l.state.PendingVersion = manifest.Version
	l.state.PendingCoreSHA256 = manifest.Core.EntrypointSHA256
	l.state.PendingDatabaseVersion = manifest.Core.DatabaseLevel
	l.state.AvailableVersion = manifest.Version
	l.state.ReleaseNotes = manifest.ReleaseNotes
	l.state.Status = "ready"
	l.state.Progress = 100
	if err := l.save(); err != nil {
		return err
	}
	return l.pruneVersions()
}

func (l *Launcher) downloadPackage(ctx context.Context, pkg Package, destination string) error {
	if !strings.HasPrefix(pkg.URL, "https://") {
		return errors.New("程序包地址必须使用 HTTPS")
	}
	var offset int64
	if info, err := os.Stat(destination); err == nil {
		offset = info.Size()
	}
	if pkg.Size > 0 && offset == pkg.Size {
		return verifyPackage(destination, pkg)
	}
	if pkg.Size > 0 && offset > pkg.Size {
		if err := os.Truncate(destination, 0); err != nil {
			return err
		}
		offset = 0
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, pkg.URL, nil)
	if err != nil {
		return err
	}
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := l.packageHTTPClient().Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	flags := os.O_CREATE | os.O_WRONLY
	if response.StatusCode == http.StatusPartialContent && offset > 0 {
		flags |= os.O_APPEND
	} else if response.StatusCode >= 200 && response.StatusCode < 300 {
		flags |= os.O_TRUNC
		offset = 0
	} else {
		return fmt.Errorf("下载程序包返回 HTTP %d", response.StatusCode)
	}
	file, err := os.OpenFile(destination, flags, 0o600)
	if err != nil {
		return err
	}
	buffer := make([]byte, 256<<10)
	written := offset
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if _, err := file.Write(buffer[:count]); err != nil {
				file.Close()
				return err
			}
			written += int64(count)
			if pkg.Size > 0 {
				l.state.Progress = int(min64(99, written*100/pkg.Size))
				_ = l.save()
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			file.Close()
			return readErr
		}
	}
	if err := file.Close(); err != nil {
		return err
	}
	return verifyPackage(destination, pkg)
}

func (l *Launcher) packageHTTPClient() *http.Client {
	if l.client == nil {
		return &http.Client{}
	}
	client := *l.client
	// The metadata client is deliberately bounded so update checks fail fast.
	// A package transfer can be hundreds of megabytes and must instead rely on
	// its request context, while retaining redirect and transport policies.
	client.Timeout = 0
	return &client
}

func verifyPackage(path string, pkg Package) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	digest := hash.Sum(nil)
	if pkg.Size > 0 && size != pkg.Size {
		return fmt.Errorf("程序包大小不匹配：%d != %d", size, pkg.Size)
	}
	if !strings.EqualFold(hex.EncodeToString(digest), pkg.SHA256) {
		return errors.New("程序包 SHA-256 校验失败")
	}
	if pkg.Signature != "" {
		return verifySignature(digest, []byte(pkg.Signature), manifestPublicKey)
	}
	return errors.New("程序包缺少签名")
}

func safeExtractZip(source, destination string) error {
	archive, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer archive.Close()
	root, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	var expanded uint64
	for _, entry := range archive.File {
		expanded += entry.UncompressedSize64
		if expanded > 4<<30 || entry.UncompressedSize64 > 2<<30 {
			return errors.New("程序包解压大小超过安全上限")
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("程序包包含不允许的符号链接：%s", entry.Name)
		}
		target, err := filepath.Abs(filepath.Join(root, entry.Name))
		if err != nil || (target != root && !strings.HasPrefix(target, root+string(os.PathSeparator))) {
			return fmt.Errorf("程序包包含不安全路径：%s", entry.Name)
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		input, err := entry.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
		if err != nil {
			input.Close()
			return err
		}
		_, copyErr := io.Copy(output, io.LimitReader(input, 2<<30))
		closeErr := output.Close()
		input.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func verifyExpandedSize(source string, expected int64) error {
	archive, err := zip.OpenReader(source)
	if err != nil {
		return err
	}
	defer archive.Close()
	var actual uint64
	for _, entry := range archive.File {
		actual += entry.UncompressedSize64
	}
	if expected <= 0 || actual != uint64(expected) {
		return fmt.Errorf("程序包解压大小不匹配：%d != %d", actual, expected)
	}
	return nil
}

func (l *Launcher) corePath(version string) string {
	entrypoint := "AutoVoucherCore.exe"
	if l.manifest != nil && l.manifest.Version == version && l.manifest.Core.Entrypoint != "" {
		entrypoint = l.manifest.Core.Entrypoint
	}
	path := filepath.Join(l.dirs.Versions, version, entrypoint)
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		if version == l.state.CurrentVersion && l.state.CoreSHA256 != "" {
			if verifyFileHash(path, l.state.CoreSHA256) != nil {
				return ""
			}
		}
		return path
	}
	return ""
}

func (l *Launcher) startCore(controlURL string) error {
	path := l.corePath(l.state.CurrentVersion)
	if path == "" {
		return errors.New("当前版本缺少核心程序")
	}
	port, err := findPort()
	if err != nil {
		return err
	}
	l.state.CorePort = port
	command := exec.Command(path, "--host", "127.0.0.1", "--port", strconv.Itoa(port), "--data-dir", l.dirs.Data, "--no-browser")
	command.Env = append(os.Environ(),
		"AUTO_VOUCHER_PORT="+strconv.Itoa(port),
		"AUTO_VOUCHER_LAUNCHER_ENDPOINT="+controlURL,
		"AUTO_VOUCHER_LAUNCHER_TOKEN="+l.token,
		"AUTO_VOUCHER_LAUNCHER_VERSION="+launcherVersion,
		"AUTO_VOUCHER_CORE_VERSION="+l.state.CurrentVersion,
	)
	versionRoot := filepath.Join(l.dirs.Versions, l.state.CurrentVersion)
	ocrWorker := filepath.Join(versionRoot, "AutoVoucherOCR.exe")
	if _, err := os.Stat(ocrWorker); err == nil {
		command.Env = append(command.Env, "AUTO_VOUCHER_OCR_WORKER="+ocrWorker)
	}
	pdfWorker := filepath.Join(versionRoot, "AutoVoucherPDF.exe")
	if _, err := os.Stat(pdfWorker); err == nil {
		command.Env = append(command.Env, "AUTO_VOUCHER_PDF_WORKER="+pdfWorker)
	}
	if err := command.Start(); err != nil {
		return err
	}
	l.core = command
	expectedDatabaseVersion := l.state.CurrentDatabaseVersion
	if l.manifest != nil && l.manifest.Version == l.state.CurrentVersion {
		expectedDatabaseVersion = l.manifest.Core.DatabaseLevel
	}
	if err := waitForHealth(
		port,
		60*time.Second,
		l.state.CurrentVersion,
		expectedDatabaseVersion,
	); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		return err
	}
	go func(running *exec.Cmd) {
		if err := running.Wait(); err != nil {
			l.log("ERROR", "CORE_EXITED", err.Error(), nil)
		}
	}(command)
	l.state.Status = "idle"
	l.state.Message = "运行正常"
	l.state.PendingDatabaseBackup = ""
	l.state.PendingDatabaseSHA256 = ""
	return l.save()
}

func (l *Launcher) rollback(controlURL string) error {
	if l.state.PreviousVersion == "" {
		return errors.New("没有可回退版本")
	}
	if err := l.restoreDatabaseBackup(); err != nil {
		l.state.Status = "recovery_failed"
		l.state.LastSupportCode = supportCode("DATABASE_RESTORE")
		l.state.Message = "更新失败且数据库备份无法自动恢复，已停止启动旧版本"
		_ = l.save()
		return fmt.Errorf("恢复更新前数据库: %w", err)
	}
	failed := l.state.CurrentVersion
	failedHash := l.state.CoreSHA256
	failedDatabaseVersion := l.state.CurrentDatabaseVersion
	l.state.CurrentVersion = l.state.PreviousVersion
	l.state.PreviousVersion = failed
	l.state.CoreSHA256 = l.state.PreviousCoreSHA256
	l.state.PreviousCoreSHA256 = failedHash
	l.state.CurrentDatabaseVersion = l.state.PreviousDatabaseVersion
	l.state.PreviousDatabaseVersion = failedDatabaseVersion
	l.state.Status = "rollback"
	l.state.LastSupportCode = supportCode("ROLLBACK")
	if err := l.save(); err != nil {
		return err
	}
	if err := l.startCore(controlURL); err != nil {
		return err
	}
	l.state.Status = "rollback"
	l.state.Message = "新版本未通过健康检查，已恢复上一版本"
	return l.save()
}

func (l *Launcher) restoreDatabaseBackup() error {
	backupPath := strings.TrimSpace(l.state.PendingDatabaseBackup)
	backupSHA256 := strings.TrimSpace(l.state.PendingDatabaseSHA256)
	if backupPath == "" || backupSHA256 == "" {
		return nil
	}
	backupRoot, err := filepath.Abs(filepath.Join(l.dirs.Data, "backups"))
	if err != nil {
		return err
	}
	absoluteBackup, err := filepath.Abs(backupPath)
	if err != nil {
		return err
	}
	if absoluteBackup != backupRoot &&
		!strings.HasPrefix(absoluteBackup, backupRoot+string(os.PathSeparator)) {
		return errors.New("数据库备份不在受控备份目录")
	}
	if err := verifyFileHash(absoluteBackup, backupSHA256); err != nil {
		return err
	}

	target := filepath.Join(l.dirs.Data, "auto-voucher.sqlite3")
	temporary := target + ".restore.tmp"
	if err := copyFile(absoluteBackup, temporary); err != nil {
		return err
	}
	if err := verifyFileHash(temporary, backupSHA256); err != nil {
		_ = os.Remove(temporary)
		return err
	}

	failedBase := filepath.Join(
		backupRoot,
		"failed-update-"+time.Now().UTC().Format("20060102T150405.000000000")+".sqlite3",
	)
	movedDatabase := false
	if _, err := os.Stat(target); err == nil {
		if err := os.Rename(target, failedBase); err != nil {
			_ = os.Remove(temporary)
			return err
		}
		movedDatabase = true
	}
	movedSidecars := make([]string, 0, 2)
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(target + suffix); err == nil {
			if err := os.Rename(target+suffix, failedBase+suffix); err != nil {
				if movedDatabase {
					_ = os.Rename(failedBase, target)
				}
				for _, movedSuffix := range movedSidecars {
					_ = os.Rename(failedBase+movedSuffix, target+movedSuffix)
				}
				_ = os.Remove(temporary)
				return err
			}
			movedSidecars = append(movedSidecars, suffix)
		}
	}
	if err := os.Rename(temporary, target); err != nil {
		if movedDatabase {
			_ = os.Rename(failedBase, target)
		}
		for _, suffix := range []string{"-wal", "-shm"} {
			_ = os.Rename(failedBase+suffix, target+suffix)
		}
		return err
	}
	l.state.PendingDatabaseBackup = ""
	l.state.PendingDatabaseSHA256 = ""
	return nil
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func (l *Launcher) openExisting() bool {
	if l.state.CorePort <= 0 {
		return false
	}
	if waitForHealth(l.state.CorePort, 800*time.Millisecond, "", 0) == nil {
		openBrowser(fmt.Sprintf("http://127.0.0.1:%d", l.state.CorePort))
		return true
	}
	return false
}

func (l *Launcher) startControlServer() (string, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	l.state.ControlPort = listener.Addr().(*net.TCPAddr).Port
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/update/status", l.authorize(l.handleStatus))
	mux.HandleFunc("/v1/update/check", l.authorize(l.handleCheck))
	mux.HandleFunc("/v1/update/download", l.authorize(l.handleDownload))
	mux.HandleFunc("/v1/update/apply", l.authorize(l.handleApply))
	mux.HandleFunc("/v1/update/postpone", l.authorize(l.handlePostpone))
	mux.HandleFunc("/v1/update/recreate-shortcut", l.authorize(l.handleShortcutRepair))
	mux.HandleFunc("/v1/diagnostics", l.authorize(l.handleDiagnostics))
	go func() {
		_ = (&http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}).Serve(listener)
	}()
	return fmt.Sprintf("http://127.0.0.1:%d", l.state.ControlPort), l.save()
}

func (l *Launcher) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+l.token {
			http.Error(writer, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		next(writer, request)
	}
}

func (l *Launcher) handleStatus(writer http.ResponseWriter, _ *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	writeJSON(writer, map[string]any{
		"available":        true,
		"status":           l.state.Status,
		"message":          l.state.Message,
		"currentVersion":   l.state.CurrentVersion,
		"availableVersion": l.state.AvailableVersion,
		"channel":          l.state.Channel,
		"progress":         l.state.Progress,
		"releaseNotes":     l.state.ReleaseNotes,
		"launcherVersion":  launcherVersion,
		"lastCheckedAt":    l.state.LastCheckedAt,
		"postponedUntil":   l.state.PostponedUntil,
		"supportCode":      l.state.LastSupportCode,
	})
}

func (l *Launcher) handleCheck(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	manifest, err := l.fetchManifest(request.Context())
	if err != nil {
		l.writeError(writer, "UPDATE_CHECK_FAILED", err)
		return
	}
	l.mu.Lock()
	l.manifest = manifest
	l.state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	mandatory := compareVersions(l.state.CurrentVersion, manifest.MinimumVersion) < 0
	if compareVersions(manifest.Version, l.state.CurrentVersion) > 0 {
		l.state.Status = "available"
		if mandatory {
			l.state.Status = "security_required"
		}
		l.state.AvailableVersion = manifest.Version
		l.state.ReleaseNotes = manifest.ReleaseNotes
		l.state.Message = "发现可用更新"
	} else {
		l.state.Status = "idle"
		l.state.Message = "当前已是最新版本"
	}
	_ = l.save()
	l.mu.Unlock()
	l.handleStatus(writer, request)
}

func (l *Launcher) handleDownload(writer http.ResponseWriter, request *http.Request) {
	l.downloadMu.Lock()
	defer l.downloadMu.Unlock()
	l.mu.Lock()
	manifest := l.manifest
	l.mu.Unlock()
	if manifest == nil {
		var err error
		manifest, err = l.fetchManifest(request.Context())
		if err != nil {
			l.writeError(writer, "UPDATE_DOWNLOAD_FAILED", err)
			return
		}
	}
	if compareVersions(manifest.Version, l.state.CurrentVersion) <= 0 {
		l.handleStatus(writer, request)
		return
	}
	if err := l.install(manifest); err != nil {
		l.writeError(writer, "UPDATE_DOWNLOAD_FAILED", err)
		return
	}
	l.handleStatus(writer, request)
}

func (l *Launcher) handleApply(writer http.ResponseWriter, request *http.Request) {
	l.mu.Lock()
	pendingVersion := l.state.PendingVersion
	l.mu.Unlock()
	if pendingVersion == "" {
		l.writeError(writer, "UPDATE_NOT_READY", errors.New("尚未下载可安装版本"))
		return
	}
	var payload struct {
		DatabaseBackup string `json:"databaseBackup"`
		DatabaseSHA256 string `json:"databaseSha256"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 1<<20)).Decode(&payload); err != nil {
		l.writeError(writer, "UPDATE_BACKUP_MISSING", err)
		return
	}
	if err := verifyFileHash(payload.DatabaseBackup, payload.DatabaseSHA256); err != nil {
		l.writeError(writer, "UPDATE_BACKUP_INVALID", err)
		return
	}
	l.mu.Lock()
	previousState := l.state
	l.state.PreviousVersion = l.state.CurrentVersion
	l.state.PreviousCoreSHA256 = l.state.CoreSHA256
	l.state.PreviousDatabaseVersion = l.state.CurrentDatabaseVersion
	l.state.CurrentVersion = pendingVersion
	l.state.CoreSHA256 = l.state.PendingCoreSHA256
	l.state.CurrentDatabaseVersion = l.state.PendingDatabaseVersion
	l.state.PendingVersion = ""
	l.state.PendingCoreSHA256 = ""
	l.state.PendingDatabaseVersion = 0
	l.state.PendingDatabaseBackup = payload.DatabaseBackup
	l.state.PendingDatabaseSHA256 = payload.DatabaseSHA256
	l.state.Status = "applying"
	if err := l.save(); err != nil {
		l.state = previousState
		l.mu.Unlock()
		l.writeError(writer, "UPDATE_STATE_SAVE_FAILED", err)
		return
	}
	l.mu.Unlock()
	writeJSON(writer, map[string]any{"available": true, "status": "applying", "currentVersion": l.state.CurrentVersion})
	go func() {
		time.Sleep(750 * time.Millisecond)
		if l.core != nil && l.core.Process != nil {
			_ = l.core.Process.Kill()
		}
		controlURL := fmt.Sprintf("http://127.0.0.1:%d", l.state.ControlPort)
		if err := l.startCore(controlURL); err != nil {
			_ = l.rollback(controlURL)
		}
	}()
}

func (l *Launcher) handleDiagnostics(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	l.mu.Lock()
	state := map[string]any{
		"launcherVersion":  launcherVersion,
		"currentVersion":   l.state.CurrentVersion,
		"previousVersion":  l.state.PreviousVersion,
		"availableVersion": l.state.AvailableVersion,
		"status":           l.state.Status,
		"lastCheckedAt":    l.state.LastCheckedAt,
		"lastSupportCode":  l.state.LastSupportCode,
	}
	l.mu.Unlock()
	writeJSON(writer, map[string]any{
		"state": state,
		"logs":  l.recentLogs(200),
	})
}

func (l *Launcher) handlePostpone(writer http.ResponseWriter, request *http.Request) {
	l.mu.Lock()
	l.state.PostponedUntil = time.Now().Add(24 * time.Hour).UTC().Format(time.RFC3339)
	l.state.Message = "已延后 24 小时提醒"
	_ = l.save()
	l.mu.Unlock()
	l.handleStatus(writer, request)
}

func (l *Launcher) handleShortcutRepair(writer http.ResponseWriter, _ *http.Request) {
	if err := createShortcut(); err != nil {
		l.writeError(writer, "SHORTCUT_CREATE_FAILED", err)
		return
	}
	writeJSON(writer, map[string]any{"available": true, "status": "shortcut_created", "message": "桌面入口已重新创建"})
}

func (l *Launcher) autoUpdateLoop() {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		l.checkForUpdate(context.Background())
	}
}

func (l *Launcher) checkForUpdate(ctx context.Context) {
	manifest, err := l.fetchManifest(ctx)
	if err != nil {
		l.log("WARNING", "UPDATE_BACKGROUND_CHECK_FAILED", err.Error(), nil)
		return
	}
	l.mu.Lock()
	l.manifest = manifest
	l.state.LastCheckedAt = time.Now().UTC().Format(time.RFC3339)
	mandatory := compareVersions(l.state.CurrentVersion, manifest.MinimumVersion) < 0
	available := false
	if compareVersions(manifest.Version, l.state.CurrentVersion) > 0 {
		available = true
		l.state.Status = "available"
		if mandatory {
			l.state.Status = "security_required"
		}
		l.state.AvailableVersion = manifest.Version
		l.state.ReleaseNotes = manifest.ReleaseNotes
		l.state.Message = "发现可用更新"
	}
	_ = l.save()
	postponed := l.postponed()
	l.mu.Unlock()
	if available && (mandatory || !postponed) {
		l.downloadMu.Lock()
		defer l.downloadMu.Unlock()
		if err := l.install(manifest); err != nil {
			l.recordBackgroundDownloadFailure(err)
		}
	}
}

func (l *Launcher) recordBackgroundDownloadFailure(err error) {
	const code = "UPDATE_BACKGROUND_DOWNLOAD_FAILED"
	l.mu.Lock()
	l.state.Status = "error"
	l.state.Message = "更新下载失败，可重新检查后继续下载：" + err.Error()
	l.state.LastSupportCode = supportCode(code)
	_ = l.save()
	support := l.state.LastSupportCode
	l.mu.Unlock()
	l.log("WARNING", code, err.Error(), map[string]any{"supportCode": support})
}

func (l *Launcher) postponed() bool {
	if l.state.PostponedUntil == "" {
		return false
	}
	until, err := time.Parse(time.RFC3339, l.state.PostponedUntil)
	return err == nil && time.Now().Before(until)
}

func (l *Launcher) pruneVersions() error {
	entries, err := os.ReadDir(l.dirs.Versions)
	if err != nil {
		return err
	}
	type versionEntry struct {
		name     string
		modified time.Time
	}
	versions := make([]versionEntry, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasSuffix(entry.Name(), ".staging") {
			continue
		}
		if info, infoErr := entry.Info(); infoErr == nil {
			versions = append(versions, versionEntry{name: entry.Name(), modified: info.ModTime()})
		}
	}
	for len(versions) > 2 {
		oldest := 0
		for index := range versions {
			if versions[index].modified.Before(versions[oldest].modified) {
				oldest = index
			}
		}
		version := versions[oldest].name
		if version != l.state.CurrentVersion && version != l.state.PreviousVersion {
			if err := os.RemoveAll(filepath.Join(l.dirs.Versions, version)); err != nil {
				return err
			}
		}
		versions = append(versions[:oldest], versions[oldest+1:]...)
	}
	return nil
}

func (l *Launcher) writeError(writer http.ResponseWriter, code string, err error) {
	l.mu.Lock()
	l.state.Status = "error"
	l.state.Message = err.Error()
	l.state.LastSupportCode = supportCode(code)
	_ = l.save()
	l.mu.Unlock()
	l.log("ERROR", code, err.Error(), map[string]any{"supportCode": l.state.LastSupportCode})
	writer.WriteHeader(http.StatusBadRequest)
	writeJSON(writer, map[string]any{"available": true, "status": "error", "message": err.Error(), "supportCode": l.state.LastSupportCode})
}

func (l *Launcher) log(level, code, message string, context map[string]any) {
	_ = rotateLogs(l.dirs.Logs)
	entry := map[string]any{
		"occurredAt":      time.Now().UTC().Format(time.RFC3339Nano),
		"level":           level,
		"eventCode":       code,
		"message":         message,
		"context":         context,
		"launcherVersion": launcherVersion,
	}
	payload, _ := json.Marshal(entry)
	file, err := os.OpenFile(filepath.Join(l.dirs.Logs, "launcher.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err == nil {
		_, _ = file.Write(append(payload, '\n'))
		_ = file.Close()
	}
}

func rotateLogs(directory string) error {
	path := filepath.Join(directory, "launcher.jsonl")
	if info, err := os.Stat(path); err == nil && info.Size() >= 10<<20 {
		_ = os.Rename(path, filepath.Join(directory, "launcher-"+time.Now().UTC().Format("20060102T150405")+".jsonl"))
	}
	entries, _ := os.ReadDir(directory)
	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	type logEntry struct {
		path     string
		size     int64
		modified time.Time
	}
	logs := make([]logEntry, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil {
			entryPath := filepath.Join(directory, entry.Name())
			if info.ModTime().Before(cutoff) {
				_ = os.Remove(entryPath)
				continue
			}
			if strings.HasPrefix(entry.Name(), "launcher") && strings.HasSuffix(entry.Name(), ".jsonl") {
				logs = append(logs, logEntry{path: entryPath, size: info.Size(), modified: info.ModTime()})
				total += info.Size()
			}
		}
	}
	for total > 20<<20 && len(logs) > 1 {
		oldest := 0
		for index := range logs {
			if logs[index].modified.Before(logs[oldest].modified) {
				oldest = index
			}
		}
		_ = os.Remove(logs[oldest].path)
		total -= logs[oldest].size
		logs = append(logs[:oldest], logs[oldest+1:]...)
	}
	return nil
}

func (l *Launcher) recentLogs(limit int) []map[string]any {
	body, err := os.ReadFile(filepath.Join(l.dirs.Logs, "launcher.jsonl"))
	if err != nil {
		return []map[string]any{}
	}
	lines := bytes.Split(body, []byte("\n"))
	if len(lines) > limit+1 {
		lines = lines[len(lines)-limit-1:]
	}
	result := make([]map[string]any, 0, len(lines))
	for _, line := range lines {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var entry map[string]any
		if json.Unmarshal(line, &entry) == nil {
			result = append(result, entry)
		}
	}
	return result
}

func waitForHealth(
	port int,
	timeout time.Duration,
	expectedVersion string,
	expectedDatabaseVersion int,
) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for time.Now().Before(deadline) {
		response, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port))
		if err == nil {
			var payload struct {
				OK              bool   `json:"ok"`
				Storage         string `json:"storage"`
				CoreVersion     string `json:"coreVersion"`
				DatabaseStatus  string `json:"databaseStatus"`
				DatabaseVersion int    `json:"databaseVersion"`
				StateVersion    int    `json:"stateVersion"`
				StaticAssets    bool   `json:"staticAssets"`
			}
			decodeErr := json.NewDecoder(response.Body).Decode(&payload)
			response.Body.Close()
			versionOK := expectedVersion == "" || payload.CoreVersion == expectedVersion
			databaseVersionOK := expectedDatabaseVersion <= 0 ||
				payload.DatabaseVersion == expectedDatabaseVersion
			detailOK := expectedVersion == "" ||
				(payload.DatabaseStatus == "ok" &&
					databaseVersionOK &&
					payload.StateVersion == 2 &&
					payload.StaticAssets)
			if decodeErr == nil && payload.OK && payload.Storage == "sqlite" && versionOK && detailOK {
				page, pageErr := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", port))
				if pageErr == nil {
					page.Body.Close()
					if page.StatusCode >= 200 && page.StatusCode < 300 {
						return nil
					}
				}
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("本地服务在限定时间内未通过健康检查")
}

func findPort() (int, error) {
	for port := 8766; port <= 8785; port++ {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err == nil {
			_ = listener.Close()
			return port, nil
		}
	}
	return 0, errors.New("8765–8785 均被占用")
}

func compareVersions(left, right string) int {
	parse := func(value string) []int {
		value = strings.TrimPrefix(value, "v")
		value = strings.SplitN(value, "-", 2)[0]
		parts := strings.Split(value, ".")
		result := make([]int, len(parts))
		for index, part := range parts {
			result[index], _ = strconv.Atoi(part)
		}
		return result
	}
	a, b := parse(left), parse(right)
	length := len(a)
	if len(b) > length {
		length = len(b)
	}
	for index := 0; index < length; index++ {
		var av, bv int
		if index < len(a) {
			av = a[index]
		}
		if index < len(b) {
			bv = b[index]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

func supportsWindowsVersion(major, build uint32) bool {
	return major > 10 || (major == 10 && build >= 19045)
}

func verifyFileHash(path, expected string) error {
	if expected == "" {
		return errors.New("缺少文件完整性摘要")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), expected) {
		return errors.New("文件完整性校验失败")
	}
	return nil
}

func writeJSON(writer http.ResponseWriter, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(payload)
}

func randomToken() string {
	value := make([]byte, 24)
	_, _ = rand.Read(value)
	return base64.RawURLEncoding.EncodeToString(value)
}

func supportCode(prefix string) string {
	return prefix + "-" + strings.ToUpper(randomToken()[:8])
}

func min64(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}

func openBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

func failUser(message string, err error) {
	detail := message + "\n支持编号：" + supportCode("START")
	if err != nil {
		detail += "\n\n" + err.Error()
	}
	showErrorAndCopy(detail)
	os.Exit(1)
}
