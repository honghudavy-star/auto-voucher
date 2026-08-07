# Auto Voucher

Auto Voucher 是一个开源、本地优先的财务凭证自动化工作台。它将业务资料导入、事项识别、凭证草稿生成、人工复核、ERP 推送和审计追踪整合在同一套流程中。

数据默认保存在用户本机。系统只生成和保存凭证草稿，不自动提交、审核、过账或结账。

## Windows Docker 一键启动（推荐）

Windows 首次使用分成两个一键步骤。第一步只准备 Docker 环境，第二步才安装并启动 Auto Voucher；这样可以先确认 Docker Engine 已经真正可用。

### 第一步：一键安装 Docker Desktop 并验证 WSL 2

以普通用户身份打开 PowerShell，复制下面这一整行命令并回车：

```powershell
$ErrorActionPreference='Stop'; $u='https://files.m.daocloud.io/raw.githubusercontent.com/honghudavy-star/auto-voucher/bfba1d9/Install-Auto-Voucher-Docker.ps1'; $p=Join-Path $env:TEMP 'Install-Auto-Voucher-Docker.ps1'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -AcceptDockerLicense -DockerOnly
```

这一步会：

1. 检测 WSL 2；未启用时请求管理员权限自动启用；
2. 必要时从中国内地加速地址下载并校验 Docker Desktop 安装器；
3. 启动 Docker Desktop，并确认 `docker version` 同时有 Client 和 Server；
4. **不会**拉取 Auto Voucher 镜像，也不会创建或修改 `auto-voucher-data` 数据卷。

如果 Windows 要求重启，重启后重新执行同一条“第一步”命令，直到看到 `Docker Desktop and WSL 2 are ready.`。

执行包含 `-AcceptDockerLicense` 的命令，表示你已阅读并接受 [Docker Desktop Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)。不接受时请不要执行。

### 第二步：一键安装并启动 Auto Voucher

确认第一步显示 Docker 已就绪后，再复制下面这一整行命令并回车：

```powershell
$ErrorActionPreference='Stop'; $u='https://files.m.daocloud.io/raw.githubusercontent.com/honghudavy-star/auto-voucher/bfba1d9/Install-Auto-Voucher-Docker.ps1'; $p=Join-Path $env:TEMP 'Install-Auto-Voucher-Docker.ps1'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -AcceptDockerLicense
```

这一步才会拉取公开的 `latest` 镜像、创建或更新 `auto-voucher` 容器，并保留 `auto-voucher-data` 数据卷。完成后访问：

```text
http://127.0.0.1:8765/
```

不需要安装 Git、Node.js 或 Python，也不会在用户电脑上构建镜像。更新、停止、卸载和故障排查请参阅 [Windows Docker 一键启动指南](docs/Windows-Docker一键启动.md)。

项目默认使用中国内地下载源：中科大 Node.js、PyPI、Python 运行时与 Debian 镜像，npmmirror npm 源，以及 DaoCloud 的 Docker Desktop、GHCR、Docker Hub 和 GitHub 文件加速。中科大 Docker Hub 镜像已经关闭，因此项目不会写入失效的 `docker.mirrors.ustc.edu.cn` 配置。

## 主要功能

- 导入 CSV、TXT、XLS、XLSX、XML、XBRL、OFD、PDF、图片和银行流水；
- 内置《小企业会计准则》（财会〔2011〕17号）66 个默认科目，支持修改、增删、恢复默认以及导入企业科目表；
- 基于确定性规则生成借贷平衡的凭证草稿；
- 校验科目、供应商、客户、部门、项目和辅助核算；
- 支持异常阻断、人工复核、操作审计和幂等回查；
- 提供飞书审批，以及金蝶云星空、用友 U8、浪潮海岳 GS Cloud 适配器框架；
- 支持 ERP API 直连或按客户模板导出；
- Windows 用户统一通过 Docker Desktop 运行；
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
python3 -m pip install --index-url https://mirrors.ustc.edu.cn/pypi/simple -e ".[ocr,pdf]"
```

## 项目结构

```text
backend/      本地服务、SQLite、导入、规则和连接器
src/          浏览器工作台
packaging/    Docker 镜像使用的 OCR/PDF worker
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
- Windows 用户安装方式仅保留 Docker Desktop 预构建镜像。

更多信息：

- [系统架构](docs/architecture.md)
- [Windows Docker 一键启动指南](docs/Windows-Docker一键启动.md)
- [金蝶 K3Cloud 查询与凭证推送参数](docs/金蝶K3Cloud查询与推送参数.md)
- [诊断日志与技术支持](docs/诊断日志与技术支持.md)
- [产品需求说明](specs/auto-voucher-prd.spec.md)

## 参与贡献

欢迎提交 Issue 和 Pull Request。涉及财务规则、ERP 字段或生产推送的改动，请同时提供测试用例，并说明适用产品、版本和验证环境。

## License

本项目采用 [Apache License 2.0](LICENSE)。
