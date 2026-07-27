import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../.github/workflows/windows-installer.yml", import.meta.url),
  "utf8",
);

test("environment UI treats OCR and PDF as bundled capabilities", () => {
  assert.equal(source.includes('data-repair-environment="reinstall-ocr"'), false);
  assert.equal(source.includes('data-repair-environment="reinstall-pdf"'), false);
  assert.equal(source.includes('data-repair-environment="recreate-shortcut"'), true);
});

test("Windows release publishes one stable complete application bundle", () => {
  assert.match(workflow, /AutoVoucherApp-\$\{\{ steps\.release\.outputs\.version \}\}-windows-x64\.zip/);
  assert.match(workflow, /group:\s+auto-voucher-windows-stable/);
  assert.doesNotMatch(workflow, /AutoVoucherCore-\$\{\{ steps\.release\.outputs\.version \}\}-windows-x64\.zip/);
  assert.doesNotMatch(workflow, /AutoVoucherOCR-\$\{\{ steps\.release\.outputs\.version \}\}-windows-x64\.zip/);
  assert.doesNotMatch(workflow, /AutoVoucherPDF-\$\{\{ steps\.release\.outputs\.version \}\}-windows-x64\.zip/);
  assert.doesNotMatch(workflow, /rollout_percentage:/);
});
