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
const npmConfigPath = new URL("../.npmrc", import.meta.url);
const uvConfigPath = new URL("../uv.toml", import.meta.url);

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
  assert.match(dockerfile, /m\.daocloud\.io\/docker\.io\/library\/node:22\.17\.1-bookworm-slim/);
  assert.match(dockerfile, /m\.daocloud\.io\/docker\.io\/library\/python:3\.12\.12-slim-bookworm/);
  assert.match(dockerfile, /registry\.npmmirror\.com/);
  assert.match(dockerfile, /mirrors\.ustc\.edu\.cn\/pypi\/simple/);
  assert.match(dockerfile, /mirrors\.ustc\.edu\.cn\/debian-security/);
  assert.match(compose, /ghcr\.m\.daocloud\.io\/honghudavy-star\/auto-voucher:latest/);
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

  assert.match(installer, /ghcr\.m\.daocloud\.io\/honghudavy-star\/auto-voucher:latest/);
  assert.match(installer, /files\.m\.daocloud\.io\/desktop\.docker\.com/);
  assert.match(installer, /Get-AuthenticodeSignature/);
  assert.match(installer, /Signature\.Status -ne "Valid"/);
  assert.match(installer, /"--accept-license"/);
  assert.match(installer, /"--backend=wsl-2"/);
  assert.match(installer, /Invoke-Docker -Arguments @\("pull", \$SelectedImage\)/);
  assert.match(installer, /"run", "--detach"/);
  assert.match(installer, /"--security-opt", "no-new-privileges"/);
  assert.match(installer, /"--cap-drop", "ALL"/);
  assert.match(installer, /"--volume", "\$VolumeName`:\/data"/);
  assert.match(installer, /ps --all --quiet --filter "name=\^\/\$ContainerName\$"/);
  assert.match(installer, /\$PreviousImageId = \(& \$script:DockerCommand inspect --format "\{\{\.Image\}\}"/);
  assert.match(installer, /Start-AutoVoucherContainer -SelectedImage \$PreviousImageId/);
  assert.match(installer, /Wait-AutoVoucherHealthy/);
  assert.match(installer, /Docker data volume was not deleted/);
  assert.doesNotMatch(installer, /docker\s+build/i);
  assert.doesNotMatch(installer, /github\.com\/.+\/archive/i);
  assert.doesNotMatch(installer, /docker\s+(?:compose\s+)?down\s+-v/i);
  assert.doesNotMatch(installer, /docker\s+volume\s+rm/i);
  assert.doesNotMatch(installer, /[^\x00-\x7F]/);
});

test("Windows Docker probe treats a stopped daemon as a boolean failure", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell 5.1 native stderr behavior is Windows-only");
    return;
  }

  const installer = await readFile(installerPath, "utf8");
  const start = installer.indexOf("function Test-DockerServer {");
  const end = installer.indexOf("\nfunction Wait-DockerServer", start);
  assert.ok(start >= 0 && end > start, "Test-DockerServer function must remain extractable");
  const probeFunction = installer.slice(start, end);
  const probe = [
    "$ErrorActionPreference = 'Stop'",
    probeFunction,
    "$script:DockerCommand = Join-Path $env:SystemRoot 'System32\\find.exe'",
    "$result = Test-DockerServer",
    "if ($result) { throw 'A failed Docker probe must not report a ready server.' }",
    "'probe-result=false'",
  ].join("\n");

  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /probe-result=false/);
});

test("Windows Docker documentation uses one command and mainland acceleration without local builds", async () => {
  const [readme, guide] = await Promise.all([
    readFile(readmePath, "utf8"),
    readFile(windowsDockerGuidePath, "utf8"),
  ]);

  assert.match(readme, /d35ce23\/Install-Auto-Voucher-Docker\.ps1/);
  assert.match(readme, /-AcceptDockerLicense/);
  assert.match(readme, /files\.m\.daocloud\.io/);
  assert.doesNotMatch(readme, /docker compose up[^\n]*--build/i);
  assert.doesNotMatch(readme, /ghcr\.io\/honghudavy-star\/auto-voucher:0\.2\.7/);

  assert.match(guide, /d35ce23\/Install-Auto-Voucher-Docker\.ps1/);
  assert.match(guide, /-AcceptDockerLicense/);
  assert.match(guide, /ghcr\.m\.daocloud\.io\/honghudavy-star\/auto-voucher:latest/);
  assert.match(guide, /中科大 Docker Hub 缓存也已经关闭/);
  assert.match(guide, /首次运行时，如果本机没有 Docker/);
  assert.match(guide, /后续运行同一条命令时，脚本会重新拉取 `latest` 镜像/);
  assert.match(guide, /新容器未通过健康检查，脚本会自动用旧镜像回滚/);
  assert.match(guide, /保留 `auto-voucher-data` 数据卷/);
  assert.doesNotMatch(guide, /docker compose up[^\n]*--build/i);
  assert.doesNotMatch(guide, /ghcr\.io\/honghudavy-star\/auto-voucher:0\.2\.7/);

  assert.match(guide, /docker volume rm auto-voucher-data/);
  assert.match(guide, /此操作不可恢复/);
});

test("project download sources default to active mainland mirrors", async () => {
  const [npmConfig, uvConfig, dockerfile] = await Promise.all([
    readFile(npmConfigPath, "utf8"),
    readFile(uvConfigPath, "utf8"),
    readFile(dockerfilePath, "utf8"),
  ]);

  assert.match(npmConfig, /registry=https:\/\/registry\.npmmirror\.com/);
  assert.match(uvConfig, /https:\/\/mirrors\.ustc\.edu\.cn\/pypi\/simple/);
  assert.match(uvConfig, /python-build-standalone/);
  assert.match(dockerfile, /m\.daocloud\.io\/docker\.io\/library\/node:/);
  assert.match(dockerfile, /m\.daocloud\.io\/docker\.io\/library\/python:/);
  assert.doesNotMatch(dockerfile, /docker\.mirrors\.ustc\.edu\.cn/);
});
