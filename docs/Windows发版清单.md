# Windows 发版清单

## 1. 一次性配置

创建 GitHub `release` 受保护环境，并在该环境中配置以下 Secrets；不得把值写入仓库、提交、日志、Artifact 或诊断包。普通 `candidate` 环境不配置发布密钥。

### Secrets

- `AUTO_VOUCHER_RELEASE_PRIVATE_KEY`：Base64 Ed25519 32 字节 seed 或 64 字节私钥。
- `CLOUDFLARE_ACCOUNT_ID`：R2 所属账号。
- `R2_ACCESS_KEY_ID`：仅允许目标 R2 Bucket 对象读写的 S3 Access Key ID。
- `R2_SECRET_ACCESS_KEY`：与上述 Access Key ID 配对的 S3 Secret Access Key。

### Variables

以下非敏感值可以作为仓库 Variables 保存：

- `AUTO_VOUCHER_CORE_BASE_URL`：公开更新根地址，必须使用 HTTPS。
- `AUTO_VOUCHER_R2_BUCKET`：目标 Bucket 名称。
- `AUTO_VOUCHER_R2_PREFIX`：Bucket 内独立对象前缀，必须与公开更新根地址的路径一致。
- `AUTO_VOUCHER_PUBLIC_UPDATE_BASE_URL`：公开读取根地址，必须与写入清单的根地址一致。

## 2. 候选包

1. 确认工作区干净，`package.json` 与 `pyproject.toml` 版本一致。
2. 运行 `npm run check`、`uv lock --check`、Go test/vet、Actionlint 和 Gitleaks。
3. 手动运行 `Windows launcher candidate`，选择 `pilot`、`publish=false`。
4. 下载 CI Artifact，在隔离 Windows x64 机器验证安装、启动、更新清单校验和卸载。

未配置正式发布密钥时可以生成开发候选包，但不得对外分发或命名为正式版本。

## 3. Pilot 发布

1. 手动运行工作流，选择 `pilot`、`publish=true`、`rollout=5`。
2. CI 必须通过 Ed25519、SHA-256、R2 上传和公开读取校验。
3. 从以下地址重新下载，不使用 CI 本地产物代替公开读取：

   ```text
   <PUBLIC_UPDATE_BASE_URL>/downloads/pilot/AutoVoucher-Setup-windows-x64.exe
   ```

4. 在干净 Windows 10 22H2 和 Windows 11 x64 各完成：
   - 首次在线安装和无管理员权限安装；
   - 确认 Windows 显示“未知发布者”，安装指引与实际操作一致；
   - 重复双击、端口冲突、离线重启；
   - Credential Manager 临时密钥写入/读取/删除；
   - CSV/XLSX 基础路径和 OCR/PDF 按需安装；
   - 更新下载中断续传；
   - 活动任务阻止重启；
   - 连续两次跨版本升级；
   - 新版本健康检查失败后数据库及程序回退；
   - SQLite 迁移失败保持原版本，失败数据库副本可诊断；
   - 一键复制问题信息和诊断包脱敏；
   - 卸载不删除业务数据。

## 4. Stable 灰度

Pilot 验收通过后，按 `5% → 20% → 50% → 100%` 手动推进 stable。每次推进必须记录：

- 工作流 Run URL、源码提交和版本；
- 清单、安装器和核心包 SHA-256；
- 未签名发布声明及对应安装指引版本；
- 公网 manifest、签名和 Content-Length/SHA-256 回读；
- Windows 验收设备、系统版本和支持编号；
- 回退演练结果。

推送与项目版本一致的 `v*` tag 会触发 stable 正式发布；tag 与版本不一致、凭据缺失、公开回读失败或安装器别名哈希不一致都会阻断。

正式 Windows 安装器和程序组件均不使用 Authenticode、SignPath 或自签名证书。发布页面必须明确说明 Windows 可能显示“未知发布者”，不得声称发布物已通过 Windows 发布者验证。Ed25519 仅用于验证更新清单，不代表 Windows 代码签名。

## 5. 回退

- 尚未更新的设备：停止扩大灰度，发布修复版本；不要覆盖已经公开发布的版本化对象。
- 已下载未应用：工作台保持旧版本运行，撤回或替换 manifest 前先确认缓存策略。
- 已应用且健康检查失败：启动器自动恢复更新前 SQLite，再启动旧核心。
- 自动数据库恢复失败：保持停止状态，不以旧核心打开未知数据库；使用支持编号、失败数据库副本和更新前备份人工恢复。
- R2 清单只能在所有引用对象存在并完成公开读取后发布，清单始终最后写入。
