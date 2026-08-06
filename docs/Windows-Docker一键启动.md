# Windows Docker 一键启动指南

本文面向希望在 Windows 电脑上直接运行 Auto Voucher 的用户。整个过程只拉取公开的预构建镜像，不会在用户电脑上编译项目。

## 运行要求

- Windows 10 或 Windows 11；
- 已启用虚拟化和 WSL 2；
- 至少保留 2 GB 可用内存；
- 本机端口 `8765` 未被其他程序占用。

不需要预先安装 Docker、Git、Node.js 或 Python。安装脚本会检测 Docker；缺少时自动下载、验签、安装并启动 Docker Desktop。

## 一条命令完成安装和启动

以普通用户身份打开 PowerShell，复制下面这一整行命令并回车：

```powershell
$ErrorActionPreference='Stop'; $u='https://files.m.daocloud.io/raw.githubusercontent.com/honghudavy-star/auto-voucher/main/Install-Auto-Voucher-Docker.ps1?v=20260805'; $p=Join-Path $env:TEMP 'Install-Auto-Voucher-Docker.ps1'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -AcceptDockerLicense
```

这条命令会自动完成：

1. 检测 Docker Desktop；未安装时从中国内地加速地址下载；
2. 校验安装器的 Docker Inc. Authenticode 数字签名，通过后才执行；
3. 安装并启动 WSL 2 / Linux containers 模式的 Docker Desktop；
4. 从中国内地 GHCR 加速地址拉取公开的 Auto Voucher `latest` 镜像；
5. 创建或更新程序容器，同时保留 `auto-voucher-data` 数据卷；
6. 等待健康检查通过，然后自动打开浏览器。

执行包含 `-AcceptDockerLicense` 的命令，表示你已阅读并接受 [Docker Desktop Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/)。如果不接受，请不要执行该命令。

首次启用 WSL 2 时，Windows 可能要求重启。重启后重新执行完全相同的命令即可，它会从已经完成的位置继续。

安装完成后，可以用下面的命令确认 Docker 已就绪：

```powershell
docker version
```

如果该命令同时显示 Client 和 Server 信息，即可继续。

镜像是在 `win-office` Windows 构建机上预先构建并验证的，用户电脑不会执行 `docker build`。

## 打开工作台

浏览器访问：

```text
http://127.0.0.1:8765/
```

也可以在 PowerShell 中执行：

```powershell
Start-Process http://127.0.0.1:8765/
```

## 检查是否启动成功

查看容器状态：

```powershell
docker ps --filter name=auto-voucher
```

检查应用健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/api/health
```

正常结果应包含：

```text
ok              : True
databaseStatus  : ok
staticAssets    : True
```

## 更新到最新版

重新执行本页开头的整行命令即可。命令会先拉取新的 `latest` 镜像，再替换程序容器，并继续使用原来的 `auto-voucher-data` 数据卷。

更新不会删除业务数据。更新重要环境前，仍建议先在工作台中导出备份包。

## 日常命令

停止程序：

```powershell
docker stop auto-voucher
```

重新启动：

```powershell
docker start auto-voucher
```

查看最近 200 行日志：

```powershell
docker logs --tail 200 auto-voucher
```

持续查看日志：

```powershell
docker logs --follow auto-voucher
```

查看当前镜像：

```powershell
docker inspect --format '{{.Config.Image}}' auto-voucher
```

## 使用其他端口

如果端口 `8765` 已被占用，可以改用 `8877`：

```powershell
$ErrorActionPreference='Stop'; $u='https://files.m.daocloud.io/raw.githubusercontent.com/honghudavy-star/auto-voucher/main/Install-Auto-Voucher-Docker.ps1?v=20260805'; $p=Join-Path $env:TEMP 'Install-Auto-Voucher-Docker.ps1'; Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -AcceptDockerLicense -Port 8877
```

然后访问 `http://127.0.0.1:8877/`。

如果已经下载完整项目，也可以执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Auto-Voucher-Docker.ps1 -AcceptDockerLicense -Port 8877
```

## 卸载程序但保留数据

删除容器和本地镜像：

```powershell
docker rm --force auto-voucher
docker image rm ghcr.m.daocloud.io/honghudavy-star/auto-voucher:latest
```

以上命令不会删除 `auto-voucher-data` 数据卷。以后重新执行一键启动命令，原有数据仍会恢复。

## 永久删除全部本地数据

先删除程序容器：

```powershell
docker rm --force auto-voucher
```

确认不再需要任何本地业务数据后，才能执行：

```powershell
docker volume rm auto-voucher-data
```

此操作不可恢复。不要使用 `docker compose down -v`，除非你同样确认要永久删除数据卷。

## 常见问题

### PowerShell 提示找不到 `docker`

重新执行本页开头的一键命令。脚本会自动安装 Docker Desktop；如果 Windows 提示需要重启，重启后再执行同一条命令。

### 提示无法连接 Docker Engine

启动 Docker Desktop，等待 Docker Engine 就绪，并确认使用 Linux containers / WSL 2 模式。然后重新执行：

```powershell
docker version
```

### 提示端口已经被占用

使用“使用其他端口”中的命令，或者先找到占用端口的程序：

```powershell
Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue
```

### 容器没有变成 healthy

查看日志和容器健康状态：

```powershell
docker logs --tail 200 auto-voucher
docker inspect --format '{{json .State.Health}}' auto-voucher
```

### 数据保存在哪里

SQLite 数据库、归档和诊断数据保存在 Docker 命名卷 `auto-voucher-data` 中。它不在项目目录里，停止或替换容器不会删除该数据卷。

## 中国内地下载源

默认下载链路如下：

- Docker Desktop、GHCR 应用镜像、Docker Hub 基础镜像和 GitHub 文件：DaoCloud 中国内地加速；
- Node.js、PyPI、Python 运行时和 Debian 软件包：中科大镜像；
- npm：npmmirror 中国内地源。

清华和中科大提供的是 Docker CE 软件包仓库，不是 Windows Docker Desktop 安装器；中科大 Docker Hub 缓存也已经关闭。因此本项目在这两类下载上使用仍可用的 DaoCloud 中国内地加速，不会向用户写入已失效的 Docker Hub 镜像地址。

只有在国内镜像临时异常且你明确愿意访问境外 GHCR 时，才可在命令末尾加 `-AllowOverseasFallback`。默认不会自动回退到境外源。

## Docker 版功能边界

Docker 端口默认只绑定到 `127.0.0.1`，不会暴露给局域网。

Linux 容器不能直接调用 Windows 凭据管理器，因此需要保存 AppSecret、访问令牌等密钥的 ERP/OA API 直连暂不适合 Docker 版。文件导入、规则处理、凭证草稿、人工复核和模板导出不受影响。
