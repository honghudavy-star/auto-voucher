import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcherPath = new URL("../scripts/start-auto-voucher.bat", import.meta.url);
const userEntryPath = new URL("../Start-Auto-Voucher.bat", import.meta.url);
const updaterPath = new URL("../scripts/source-update.ps1", import.meta.url);
const statusPagePath = new URL("../scripts/startup-status.ps1", import.meta.url);
const bundleBuilderPath = new URL("../scripts/build-windows-source-bundle.ps1", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("Windows BAT launcher preserves the complete source runtime", async () => {
  const [launcher, userEntry, updater, statusPage, bundleBuilder, packageJson] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(userEntryPath, "utf8"),
    readFile(updaterPath, "utf8"),
    readFile(statusPagePath, "utf8"),
    readFile(bundleBuilderPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);

  assert.match(userEntry, /APP_DIR=%~dp0AutoVoucher/);
  assert.match(userEntry, /LAUNCHER=%APP_DIR%\\scripts\\start-auto-voucher\.bat/);
  assert.match(userEntry, /package is incomplete/);
  assert.match(userEntry, /pause/);
  assert.doesNotMatch(userEntry, /[^\x00-\x7F]/);
  assert.match(launcher, /startup-status\.ps1/);
  assert.match(launcher, /start "" "%STATUS_PAGE%"/);
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
  assert.match(statusPage, /&#27491;&#22312;&#26816;&#27979;/);
  assert.match(statusPage, /Node\.js/);
  assert.match(statusPage, /Python/);
  assert.match(statusPage, /location\.replace/);
  assert.doesNotMatch(statusPage, /[^\x00-\x7F]/);
  assert.match(bundleBuilder, /"AutoVoucher"/);
  assert.match(bundleBuilder, /"Start-Auto-Voucher\.bat"/);
  assert.match(bundleBuilder, /Remove-Item -LiteralPath \(Join-Path \$inner "Start-Auto-Voucher\.bat"\)/);
  assert.match(bundleBuilder, /Bundle root must contain only/);
  assert.match(bundleBuilder, /exit 0\s*$/);
  assert.equal(packageJson.version, "0.2.4");
  assert.doesNotMatch(launcher, /AutoVoucher(?:Core|OCR|PDF|Setup).*\.exe/i);
});
