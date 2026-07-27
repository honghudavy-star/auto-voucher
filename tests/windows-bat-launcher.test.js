import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcherPath = new URL("../scripts/start-auto-voucher.bat", import.meta.url);
const userEntryPath = new URL("../Start-Auto-Voucher.bat", import.meta.url);
const updaterPath = new URL("../scripts/source-update.ps1", import.meta.url);
const environmentBootstrapPath = new URL("../scripts/environment-bootstrap.ps1", import.meta.url);
const bundleBuilderPath = new URL("../scripts/build-windows-source-bundle.ps1", import.meta.url);
const sourceReleaseWorkflowPath = new URL("../.github/workflows/windows-source-release.yml", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("Windows BAT launcher preserves the complete source runtime", async () => {
  const [launcher, userEntry, updater, environmentBootstrap, bundleBuilder, sourceReleaseWorkflow, packageJson] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(userEntryPath, "utf8"),
    readFile(updaterPath, "utf8"),
    readFile(environmentBootstrapPath, "utf8"),
    readFile(bundleBuilderPath, "utf8"),
    readFile(sourceReleaseWorkflowPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);

  assert.match(userEntry, /APP_DIR=%~dp0AutoVoucher/);
  assert.match(userEntry, /LAUNCHER=%APP_DIR%\\scripts\\start-auto-voucher\.bat/);
  assert.match(userEntry, /package is incomplete/);
  assert.match(userEntry, /pause/);
  assert.doesNotMatch(userEntry, /[^\x00-\x7F]/);
  assert.match(launcher, /environment-bootstrap\.ps1/);
  assert.match(launcher, /start "" "%ENV_URL%"/);
  assert.match(launcher, /environment-ready/);
  assert.match(launcher, /call "%ENV_COMMAND%"/);
  assert.match(launcher, /:wait_for_environment/);
  assert.match(launcher, /ENV_SERVER_OUT=.*environment-server\.out\.log/);
  assert.match(launcher, /ENV_SERVER_ERR=.*environment-server\.err\.log/);
  assert.doesNotMatch(launcher, /-Mode Serve[^\r\n]*LOG_FILE/);
  assert.match(launcher, /Start-Process/);
  assert.match(launcher, /startup\.log/);
  assert.match(launcher, /scripts\\source-update\.ps1/);
  assert.match(launcher, /require\('\.\/package\.json'\)\.version/);
  assert.match(launcher, /-e "\.\[ocr,pdf\]"/);
  assert.match(launcher, /AUTO_VOUCHER_OCR_WORKER=.*packaging\\ocr_worker\.py/);
  assert.match(launcher, /AUTO_VOUCHER_PDF_WORKER=.*packaging\\pdf_worker\.py/);
  assert.match(launcher, /call npm run build/);
  assert.match(launcher, /-m','auto_voucher','--no-browser'/);
  assert.match(launcher, /AUTO_VOUCHER_PORT/);
  assert.doesNotMatch(launcher, /[^\x00-\x7F]/);
  assert.match(updater, /raw\.githubusercontent\.com\/\$repository\/main\/package\.json/);
  assert.match(updater, /archive\/refs\/heads\/main\.zip/);
  assert.match(updater, /Start-Auto-Voucher\.bat/);
  assert.match(updater, /exit 0\s*$/);
  assert.match(environmentBootstrap, /id="action"/);
  assert.match(environmentBootstrap, /\/api\/install/);
  assert.match(environmentBootstrap, /\/api\/status/);
  assert.match(environmentBootstrap, /ExitWhenTerminal/);
  assert.match(environmentBootstrap, /Install-LocalNode/);
  assert.match(environmentBootstrap, /Install-LocalPython/);
  assert.match(environmentBootstrap, /UV_PYTHON_INSTALL_DIR/);
  assert.match(environmentBootstrap, /UV_PYTHON_BIN_DIR/);
  assert.match(environmentBootstrap, /environment-state\.\$\(\$PID\)\.tmp/);
  assert.match(environmentBootstrap, /environment-state\.\$\(\$PID\)\.bak/);
  assert.match(environmentBootstrap, /\[IO\.File\]::Replace/);
  assert.match(environmentBootstrap, /python install \$pythonVersion --managed-python --no-progress/);
  assert.match(environmentBootstrap, /python find \$pythonVersion --managed-python/);
  assert.match(environmentBootstrap, /7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29/);
  assert.match(environmentBootstrap, /acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984/);
  assert.doesNotMatch(environmentBootstrap, /python-\$pythonVersion-amd64\.exe/);
  assert.doesNotMatch(environmentBootstrap, /Get-AuthenticodeSignature/);
  assert.match(environmentBootstrap, /&#33258;&#21160;&#23433;&#35013;&#29615;&#22659;&#24182;&#32487;&#32493;/);
  assert.doesNotMatch(environmentBootstrap, /href="https:\/\//);
  assert.doesNotMatch(environmentBootstrap, /[^\x00-\x7F]/);
  assert.match(bundleBuilder, /"AutoVoucher"/);
  assert.match(bundleBuilder, /"Start-Auto-Voucher\.bat"/);
  assert.match(bundleBuilder, /Remove-Item -LiteralPath \(Join-Path \$inner "Start-Auto-Voucher\.bat"\)/);
  assert.match(bundleBuilder, /Bundle root must contain only/);
  assert.match(bundleBuilder, /exit 0\s*$/);
  assert.match(sourceReleaseWorkflow, /Automatic environment button is missing/);
  assert.match(sourceReleaseWorkflow, /Environment bootstrap did not reach ready state/);
  assert.match(sourceReleaseWorkflow, /-ExitWhenTerminal/);
  assert.doesNotMatch(sourceReleaseWorkflow, /Stop-Job/);
  assert.doesNotMatch(sourceReleaseWorkflow, /startup-status\.ps1/);
  assert.equal(packageJson.version, "0.2.7");
  assert.doesNotMatch(launcher, /AutoVoucher(?:Core|OCR|PDF|Setup).*\.exe/i);
});
