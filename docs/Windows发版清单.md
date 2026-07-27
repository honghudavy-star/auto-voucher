# Windows 发版清单

Auto Voucher 只维护一个 `stable` 更新流。每个版本只有一个完整应用包：

```text
AutoVoucherApp-<version>-windows-x64.zip
  ├─ AutoVoucherCore.exe
  ├─ AutoVoucherOCR.exe
  └─ AutoVoucherPDF.exe
```

Launcher、安装器和 schema v1 签名清单继续保留。清单中的 `core`、空
`components` 和 `rolloutPercentage: 100` 仅用于兼容已经安装的 0.2.x
Launcher，不再是发布选项。

## 一次性配置

GitHub `release` 环境保存：

- `AUTO_VOUCHER_RELEASE_PRIVATE_KEY`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

仓库 Variables 保存：

- `AUTO_VOUCHER_CORE_BASE_URL`
- `AUTO_VOUCHER_R2_BUCKET`
- `AUTO_VOUCHER_R2_PREFIX`
- `AUTO_VOUCHER_PUBLIC_UPDATE_BASE_URL`

密钥不得写入仓库、日志、Artifact 或诊断包。

## 候选验证

1. 工作区必须干净，`package.json` 与 `pyproject.toml` 版本一致。
2. 本地运行 `npm run check`、`uv lock --check`、Go test/vet、Actionlint 和 Gitleaks。
3. 在 `win-office` 从干净 Git Checkout 运行同一发布脚本。
4. 手动运行 `Windows release`，保持 `publish=false`。
5. 候选 Artifact 必须只包含一个 App ZIP、Launcher、安装器和签名清单。
6. 在隔离目录完成首次安装、启动、OCR、PDF、离线重启和卸载验证。

候选失败时停止，不触发正式发布。

## 正式发布

1. 候选通过后，推送与项目版本一致且指向当前 `main` 的 `v*` tag，或手动运行
   `Windows release` 并设置 `publish=true`。
2. CI 只构建一次完整应用包；发布步骤使用同一份字节，不重新打包。
3. 先上传带版本号的 App ZIP、Launcher 和安装器并回读大小与 SHA-256。
4. 最后上传签名 manifest；任何前置步骤失败都不得更新 manifest。
5. 从公网重新下载安装器，在 Windows 10 22H2 或 Windows 11 x64 验证：
   - 首次在线安装与非管理员安装；
   - 从上一版本在线升级；
   - Core、OCR、PDF 均来自同一版本目录；
   - 数据库升级失败时恢复上一版本；
   - 卸载不删除业务数据。

## 回退

- 尚未更新的设备：恢复上一份签名 manifest，版本化对象不覆盖、不删除。
- 已下载未应用：继续运行旧版本。
- 已应用但健康检查失败：Launcher 恢复更新前数据库并启动上一版本。
- 数据库无法恢复：保持停止，保留失败副本和支持编号，禁止旧版本打开未知数据库。
