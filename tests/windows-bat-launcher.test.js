import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const launcherPath = new URL("../启动 Auto Voucher.bat", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("Windows BAT launcher preserves the complete source runtime", async () => {
  const [launcher, packageJson] = await Promise.all([
    readFile(launcherPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
  ]);

  assert.match(launcher, new RegExp(`set "APP_VERSION=${packageJson.version}"`));
  assert.match(launcher, /-e "\.\[ocr,pdf\]"/);
  assert.match(launcher, /AUTO_VOUCHER_OCR_WORKER=.*packaging\\ocr_worker\.py/);
  assert.match(launcher, /AUTO_VOUCHER_PDF_WORKER=.*packaging\\pdf_worker\.py/);
  assert.match(launcher, /call npm run build/);
  assert.match(launcher, /"%VENV_PYTHON%" -m auto_voucher/);
  assert.match(launcher, /AUTO_VOUCHER_NO_BROWSER/);
  assert.match(launcher, /AUTO_VOUCHER_PORT/);
  assert.doesNotMatch(launcher, /AutoVoucher(?:Core|OCR|PDF|Setup).*\.exe/i);
  assert.doesNotMatch(launcher, /powershell|executionpolicy/i);
});
