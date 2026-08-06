# Auto Voucher

Auto Voucher 是一个开源、本地优先的财务凭证自动化工作台。它将业务资料导入、事项识别、凭证草稿生成、人工复核、ERP 推送和审计追踪整合在同一套流程中。

数据默认保存在用户本机。系统只生成和保存凭证草稿，不自动提交、审核、过账或结账。

## Windows Docker 一键启动（推荐）

适用于 Windows 10/11。用户电脑只需要安装并启动 Docker Desktop，不需要安装 Git、Node.js 或 Python，也不会在本机编译项目。

如果尚未安装 Docker Desktop，请先在 PowerShell 中执行：

```powershell
winget install -e --id Docker.DockerDesktop
```

安装完成后启动 Docker Desktop，并确认使用默认的 **Linux containers / WSL 2** 模式。然后打开 PowerShell，复制下面这一整行命令：

```powershell
$img='ghcr.io/honghudavy-star/auto-voucher:latest'; docker pull $img; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker rm --force auto-voucher 2>$null; docker volume create auto-voucher-data | Out-Null; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker run --detach --name auto-voucher --restart unless-stopped --init --security-opt no-new-privileges --cap-drop ALL --cpus 2 --memory 2g --pids-limit 256 --publish 127.0.0.1:8765:8765 --volume auto-voucher-data:/data $img
```

该命令会从公开的 GHCR 拉取由 **`win-office` Windows 构建机**预先构建的 `latest` 镜像，创建程序容器，并将业务数据保存在 `auto-voucher-data` 数据卷中。重新执行同一条命令即可更新程序，原有数据不会被删除。

启动后访问：

```text
http://127.0.0.1:8765/
```

检查运行状态：

```powershell
docker ps --filter name=auto-voucher
Invoke-RestMethod http://127.0.0.1:8765/api/health
```

停止和重新启动：

```powershell
docker stop auto-voucher
docker start auto-voucher
```

查看日志：

```powershell
docker logs --tail 200 auto-voucher
```

如果已经下载完整项目，也可以运行根目录的安装器。它会执行健康检查，并在更新失败时恢复旧镜像：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Auto-Voucher-Docker.ps1
```

或者双击 `Start-Auto-Voucher-Docker.bat`，使用 Compose 拉取并启动公开镜像。两个入口都不会执行 `docker build`。

指定其他端口：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Auto-Voucher-Docker.ps1 -Port 8877
```

然后访问 `http://127.0.0.1:8877/`。

数据保存在 Docker 命名卷 **`auto-voucher-data`** 中。停止、更新或重建容器都不会删除该卷。不要运行下面的命令，除非你确认要永久删除全部本地业务数据：

```powershell
docker volume rm auto-voucher-data
```

也不要使用 `docker compose down -v`。重要数据仍应定期在工作台中导出备份包。

Docker 版的端口只发布到 Windows 本机 `127.0.0.1`，不会默认暴露给局域网。当前 Linux 容器不能直接调用 Windows 凭据管理器，因此需要保存 AppSecret、访问令牌等密钥的 ERP/OA API 直连暂不适合 Docker 版；文件导入、规则处理、凭证草稿、人工复核和模板导出不受影响。需要完整连接器密钥能力时，请继续使用下面的 Windows 源码运行方式。

完整操作、更新、卸载和故障排查请参阅 [Windows Docker 一键启动指南](docs/Windows-Docker一键启动.md)。

## Windows 源码运行

目前不再向新用户提供未签名的 EXE 安装包。Windows 用户下载专用源码包即可：

- [下载 Auto Voucher Windows 源码包](https://github.com/honghudavy-star/auto-voucher/releases/latest/download/Auto-Voucher-Windows.zip)

使用方式：

1. 解压下载的 ZIP；
2. 最外层只有 **`Start-Auto-Voucher.bat`** 和内部程序文件夹；
3. 双击 **`Start-Auto-Voucher.bat`**，浏览器会立即打开本地环境配置页面；
4. 点击 **“自动安装环境并继续”**，等待页面显示环境成功并自动进入工作台。

配置页会明确显示 Node.js 与 Python 是否就绪。缺少组件时不再要求用户自行下载或选择安装路径：页面上的按钮会下载固定的官方版本、校验 SHA-256，并将 Node.js 与 Python 配置在项目内部；失败时可直接重试，成功后才会继续安装 Core、OCR、PDF 全部组件。后续运行会复用现有环境。BAT 每次启动也会检查更高的源码版本；更新失败时继续运行当前版本，不影响已有环境下的离线启动。程序准备完成后会自动进入工作台；如果没有自动进入，请访问：

```text
http://127.0.0.1:8765/
```

## 主要功能

- 导入 CSV、TXT、XLS、XLSX、XML、XBRL、OFD、PDF、图片和银行流水；
- 内置《小企业会计准则》（财会〔2011〕17号）66 个默认科目，支持修改、增删、恢复默认以及导入企业科目表；
- 基于确定性规则生成借贷平衡的凭证草稿；
- 校验科目、供应商、客户、部门、项目和辅助核算；
- 支持异常阻断、人工复核、操作审计和幂等回查；
- 提供飞书审批，以及金蝶云星空、用友 U8、浪潮海岳 GS Cloud 适配器框架；
- 支持 ERP API 直连或按客户模板导出；
- 历史 Windows 启动器代码保留用于已有版本维护，新用户通过源码运行；
- 一键复制脱敏诊断信息，不自动上传业务数据。

## 工作流程

工作台包含四个一级入口：

1. **接入方案**：选择企业、目标 ERP、数据来源和业务场景；
2. **系统与数据**：配置连接器、账套和基础资料；
3. **凭证场景**：维护字段映射、会计分录和异常规则；
4. **凭证工作台**：导入资料、生成凭证、复核、推送和查询。

未完成生产启用验证时，生产导出和推送保持禁用。

## macOS / Linux 本地开发

需要 Node.js 20+、Python 3.11+。

```bash
git clone https://github.com/honghudavy-star/auto-voucher.git
cd auto-voucher
npm install
npm run setup:python
npm start
```

启动后访问：

```text
http://127.0.0.1:8765/
```

运行完整检查：

```bash
npm run check
```

OCR 和 PDF 识别是可选组件：

```bash
python3 -m pip install -e ".[ocr,pdf]"
```

## 项目结构

```text
backend/      本地服务、SQLite、导入、规则和连接器
src/          浏览器工作台
launcher/     Windows Go 轻量启动器
packaging/    PyInstaller 与 Inno Setup 打包配置
tests/        前端领域测试
docs/         架构、诊断和发布文档
Dockerfile    Linux 容器镜像构建
docker-compose.yml  Windows Docker Desktop 一键运行编排
Install-Auto-Voucher-Docker.ps1  Windows 预构建镜像安装器
```

## 当前边界

- ERP 适配器已完成统一接口与自动化合同测试，真实客户环境仍需使用客户提供的版本、接口文档和测试账套验收；
- 文件上传不等于审批通过，审批、资料验证、财务复核和允许推送是独立状态；
- 扫描件识别结果只作为候选数据，必须经过人工确认；
- 密钥仅写入操作系统密钥库，不进入 SQLite、日志或备份；
- Windows 源码包会在本地配置页自动准备 Node.js 与 Python；现阶段不再将未签名 EXE 作为新用户下载入口。

更多信息：

- [系统架构](docs/architecture.md)
- [Windows Docker 一键启动指南](docs/Windows-Docker一键启动.md)
- [金蝶 K3Cloud 查询与凭证推送参数](docs/金蝶K3Cloud查询与推送参数.md)
- [诊断日志与技术支持](docs/诊断日志与技术支持.md)
- [Windows 发版清单](docs/Windows发版清单.md)
- [v0.2.2 发布说明](docs/v0.2.2发布说明.md)
- [v0.2.0 发布说明](docs/v0.2.0发布说明.md)
- [长视频讲解与宣传脚本](docs/Auto-Voucher长视频讲解与宣传脚本.md)
- [小红书文案与实机录屏脚本](docs/小红书与实机录屏文案.md)
- [产品需求说明](specs/auto-voucher-prd.spec.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。涉及财务规则、ERP 字段或生产推送的改动，请同时提供测试用例，并说明适用产品、版本和验证环境。

## License

本项目采用 [Apache License 2.0](LICENSE)。
