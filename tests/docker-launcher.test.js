import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const composePath = new URL("../docker-compose.yml", import.meta.url);
const batchPath = new URL("../Start-Auto-Voucher-Docker.bat", import.meta.url);
const powershellPath = new URL("../Start-Auto-Voucher-Docker.ps1", import.meta.url);
const installerPath = new URL("../Install-Auto-Voucher-Docker.ps1", import.meta.url);
const readmePath = new URL("../README.md", import.meta.url);
const windowsDockerGuidePath = new URL("../docs/Windows-Docker一键启动.md", import.meta.url);

test("Docker launcher keeps Windows startup local, persistent, and health-gated", async () => {
  const [dockerfile, compose, batch, powershell] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(composePath, "utf8"),
    readFile(batchPath, "utf8"),
    readFile(powershellPath, "utf8"),
  ]);

  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /--host", "0\.0\.0\.0"/);
  assert.match(dockerfile, /AUTO_VOUCHER_DATA_DIR=\/data/);
  assert.match(dockerfile, /opencv-python-headless==4\.11\.0\.86/);
  assert.match(dockerfile, /--only-upgrade\s+\\\s+libgnutls30\s+\\\s+libssl3\s+\\\s+openssl/);
  assert.match(compose, /ghcr\.io\/honghudavy-star\/auto-voucher:latest/);
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.match(compose, /127\.0\.0\.1:\$\{AUTO_VOUCHER_PORT:-8765\}:8765/);
  assert.match(compose, /auto-voucher-data:\/data/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s*- ALL/);
  assert.match(compose, /mem_limit: 2g/);
  assert.match(batch, /Start-Auto-Voucher-Docker\.ps1/);
  assert.doesNotMatch(batch, /[^\x00-\x7F]/);
  assert.match(powershell, /"pull", "app"/);
  assert.match(powershell, /"up", "--detach", "--no-build", "--wait"/);
  assert.doesNotMatch(powershell, /"--build"/);
  assert.match(powershell, /api\/health/);
  assert.match(powershell, /Start-Process \$AppUrl/);
  assert.doesNotMatch(powershell, /[^\x00-\x7F]/);
});

test("Windows installer only pulls the prebuilt image and preserves Docker data during rollback", async () => {
  const installer = await readFile(installerPath, "utf8");

  assert.match(installer, /ghcr\.io\/honghudavy-star\/auto-voucher:latest/);
  assert.match(installer, /Invoke-Docker -Arguments @\("pull", \$Image\)/);
  assert.match(installer, /"run", "--detach"/);
  assert.match(installer, /"--security-opt", "no-new-privileges"/);
  assert.match(installer, /"--cap-drop", "ALL"/);
  assert.match(installer, /"--volume", "\$VolumeName`:\/data"/);
  assert.match(installer, /\$PreviousImageId = \(& docker inspect --format "\{\{\.Image\}\}"/);
  assert.match(installer, /Start-AutoVoucherContainer -SelectedImage \$PreviousImageId/);
  assert.match(installer, /Wait-AutoVoucherHealthy/);
  assert.match(installer, /Docker data volume was not deleted/);
  assert.doesNotMatch(installer, /docker\s+build/i);
  assert.doesNotMatch(installer, /github\.com\/.+\/archive/i);
  assert.doesNotMatch(installer, /docker\s+(?:compose\s+)?down\s+-v/i);
  assert.doesNotMatch(installer, /docker\s+volume\s+rm/i);
  assert.doesNotMatch(installer, /[^\x00-\x7F]/);
});

test("Windows Docker documentation uses the public latest image without local builds", async () => {
  const [readme, guide] = await Promise.all([
    readFile(readmePath, "utf8"),
    readFile(windowsDockerGuidePath, "utf8"),
  ]);

  for (const document of [readme, guide]) {
    assert.match(document, /ghcr\.io\/honghudavy-star\/auto-voucher:latest/);
    assert.match(document, /docker pull \$img/);
    assert.match(document, /\$LASTEXITCODE -ne 0/);
    assert.match(document, /auto-voucher-data:\/data/);
    assert.doesNotMatch(document, /docker compose up[^\n]*--build/i);
    assert.doesNotMatch(document, /ghcr\.io\/honghudavy-star\/auto-voucher:0\.2\.7/);
  }

  assert.match(guide, /docker volume rm auto-voucher-data/);
  assert.match(guide, /此操作不可恢复/);
});
