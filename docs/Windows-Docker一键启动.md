# Windows Docker 一键启动指南

本文面向希望在 Windows 电脑上直接运行 Auto Voucher 的用户。整个过程只拉取公开的预构建镜像，不会在用户电脑上编译项目。

## 运行要求

- Windows 10 或 Windows 11；
- 已启用硬件虚拟化；WSL 2 未启用时，一键脚本会请求管理员权限自动启用；
- 至少保留 2 GB 可用内存；
- 本机端口 `8765` 未被其他程序占用。

不需要预先安装 Docker、WSL、Git、Node.js 或 Python。安装脚本会自动检测并启用 WSL 2，再下载、验签、安装并启动 Docker Desktop。

## 一键安装

以普通用户身份打开 PowerShell，复制这一行并回车：

```powershell
irm https://finance.iagent7.com/install.ps1 | iex
```

这条命令会：

1. 从 `finance.iagent7.com` 获取公开引导脚本；
2. 下载固定 Git 提交的完整安装器，并在本机核对 SHA-256；
3. 检测 WSL 2 和 Docker Desktop，必要时请求管理员权限完成准备；
4. 拉取预构建 Auto Voucher 镜像，创建或更新容器并等待健康检查。

如果想先查看公开引导脚本，不执行，请运行：

```powershell
irm https://finance.iagent7.com/install.ps1 | more
```

Docker Desktop 缺失时，安装器会显示 [Docker Desktop Subscription Service Agreement](https://www.docker.com/legal/docker-subscription-service-agreement/) 地址并要求输入 `YES`。只有明确输入 `YES` 才会下载和安装 Docker Desktop；其他输入会停止，且不会开始 Docker 安装。

首次启用 WSL 2 时，Windows 可能要求重启。重启后重新执行同一条短命令；如果弹出管理员确认，请选择“是”。

安装完成后，可以用下面的命令确认 Docker 已就绪：

```powershell
docker version
```

如果该命令同时显示 Client 和 Server 信息，Docker 环境已经就绪。短命令会继续优先从中国内地 GHCR 加速地址拉取公开的 Auto Voucher `latest` 镜像；如果加速服务拒绝或失败，安装器会自动尝试官方 GHCR。随后创建或更新程序容器，同时保留 `auto-voucher-data` 数据卷，并等待健康检查通过后打开浏览器。

镜像是在 `win-office` Windows 构建机上预先构建并验证的，用户电脑不会执行 `docker build`。

## 首次安装与后续更新

首次运行时，短命令会先完成 Docker Desktop/WSL 2 准备，再拉取镜像、创建 `auto-voucher` 容器和 `auto-voucher-data` 数据卷。

后续更新时重新执行同一条短命令，脚本会重新拉取 `latest` 镜像，替换旧容器并继续挂载原来的数据卷。更新过程中不会删除业务数据；如果新容器未通过健康检查，脚本会自动用旧镜像回滚。

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

重新执行本页的一键安装短命令即可。命令会先拉取新的 `latest` 镜像，再替换程序容器，并继续使用原来的 `auto-voucher-data` 数据卷。

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

如果端口 `8765` 已被占用，下载完整项目后可以改用 `8877`：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Auto-Voucher-Docker.ps1 -AcceptDockerLicense -Port 8877
```

然后访问 `http://127.0.0.1:8877/`。普通用户建议保留默认端口，继续使用一键安装短命令。

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

重新执行本页的一键安装短命令。脚本会检查 Docker Desktop 和 WSL 2；如果 Windows 提示需要重启，重启后再执行同一条命令。

### 提示 `Docker Desktop - WSL not installed`

这是 Docker Desktop 的 WSL 2 后端尚未启用。重新执行本页的一键安装短命令，脚本会请求管理员权限运行 `wsl.exe --install --no-distribution`；如果 Windows 要求重启，重启后再执行同一条命令即可。

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

优先下载链路如下：

- Docker Desktop、GHCR 应用镜像、Docker Hub 基础镜像和 GitHub 文件：DaoCloud 中国内地加速；GHCR 应用镜像加速失败时自动尝试官方 GHCR；
- Node.js、PyPI、Python 运行时和 Debian 软件包：中科大镜像；
- npm：npmmirror 中国内地源。

清华和中科大提供的是 Docker CE 软件包仓库，不是 Windows Docker Desktop 安装器；中科大 Docker Hub 缓存也已经关闭。因此本项目在这两类下载上使用仍可用的 DaoCloud 中国内地加速，不会向用户写入已失效的 Docker Hub 镜像地址。

只有默认的 DaoCloud 应用镜像拉取失败时，安装器才会自动尝试官方 GHCR；自定义 `-Image` 地址失败时不会擅自改用其他镜像。

## Docker 版功能边界

Docker 端口默认只绑定到 `127.0.0.1`，不会暴露给局域网。

Linux 容器不能直接调用 Windows 凭据管理器，因此需要保存 AppSecret、访问令牌等密钥的 ERP/OA API 直连暂不适合 Docker 版。文件导入、规则处理、凭证草稿、人工复核和模板导出不受影响。
