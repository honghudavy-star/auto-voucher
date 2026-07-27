import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcherPath = new URL("../scripts/start-auto-voucher.bat", import.meta.url);
const userEntryPath = new URL("../Start-Auto-Voucher.bat", import.meta.url);
const updaterPath = new URL("../scripts/source-update.ps1", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("Windows BAT launcher preserves the complete source runtime", async () => {
  const [launcher, userEntry, updater, packageJson] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(userEntryPath, "utf8"),
    readFile(updaterPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);

  assert.match(userEntry, /scripts\\start-auto-voucher\.bat/);
  assert.match(launcher, /scripts\\source-update\.ps1/);
  assert.match(launcher, /require\('\.\/package\.json'\)\.version/);
  assert.match(launcher, /-e "\.\[ocr,pdf\]"/);
  assert.match(launcher, /AUTO_VOUCHER_OCR_WORKER=.*packaging\\ocr_worker\.py/);
  assert.match(launcher, /AUTO_VOUCHER_PDF_WORKER=.*packaging\\pdf_worker\.py/);
  assert.match(launcher, /call npm run build/);
  assert.match(launcher, /"%VENV_PYTHON%" -m auto_voucher/);
  assert.match(launcher, /AUTO_VOUCHER_NO_BROWSER/);
  assert.match(launcher, /AUTO_VOUCHER_PORT/);
  assert.match(updater, /raw\.githubusercontent\.com\/\$repository\/main\/package\.json/);
  assert.match(updater, /archive\/refs\/heads\/main\.zip/);
  assert.match(updater, /Start-Auto-Voucher\.bat/);
  assert.equal(packageJson.version, "0.2.3");
  assert.doesNotMatch(launcher, /AutoVoucher(?:Core|OCR|PDF|Setup).*\.exe/i);
});
