# Windows Docker 一键启动指南

本文面向希望在 Windows 电脑上直接运行 Auto Voucher 的用户。整个过程只拉取公开的预构建镜像，不会在用户电脑上编译项目。

## 运行要求

- Windows 10 或 Windows 11；
- 已启用虚拟化和 WSL 2；
- Docker Desktop 使用 Linux containers / WSL 2 模式；
- 至少保留 2 GB 可用内存；
- 本机端口 `8765` 未被其他程序占用。

不需要安装 Git、Node.js 或 Python。

## 第一步：安装并启动 Docker Desktop

以普通用户身份打开 PowerShell，执行：

```powershell
winget install -e --id Docker.DockerDesktop
```

安装完成后，根据提示注销或重启 Windows，然后启动 Docker Desktop。等待界面显示 Docker Engine 正在运行。

可以用下面的命令确认 Docker 已就绪：

```powershell
docker version
```

如果该命令同时显示 Client 和 Server 信息，即可继续。

## 第二步：一键启动 Auto Voucher

打开 PowerShell，复制下面这一整行命令并回车：

```powershell
$img='ghcr.io/honghudavy-star/auto-voucher:latest'; docker pull $img; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker rm --force auto-voucher 2>$null; docker volume create auto-voucher-data | Out-Null; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker run --detach --name auto-voucher --restart unless-stopped --init --security-opt no-new-privileges --cap-drop ALL --cpus 2 --memory 2g --pids-limit 256 --publish 127.0.0.1:8765:8765 --volume auto-voucher-data:/data $img
```

该命令会完成以下操作：

1. 从公开的 GitHub Container Registry 拉取 `latest` 镜像；
2. 替换名为 `auto-voucher` 的旧程序容器；
3. 创建或复用 `auto-voucher-data` 数据卷；
4. 仅在本机 `127.0.0.1:8765` 提供访问；
5. 设置 Docker Desktop 启动后自动恢复容器。

镜像是在 `win-office` Windows 构建机上预先构建并验证的，用户电脑不会执行 `docker build`。

## 第三步：打开工作台

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

重新执行“一键启动”中的整行命令即可。命令会先拉取新的 `latest` 镜像，再替换程序容器，并继续使用原来的 `auto-voucher-data` 数据卷。

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
$img='ghcr.io/honghudavy-star/auto-voucher:latest'; docker pull $img; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker rm --force auto-voucher 2>$null; docker volume create auto-voucher-data | Out-Null; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; docker run --detach --name auto-voucher --restart unless-stopped --init --security-opt no-new-privileges --cap-drop ALL --cpus 2 --memory 2g --pids-limit 256 --publish 127.0.0.1:8877:8765 --volume auto-voucher-data:/data $img
```

然后访问 `http://127.0.0.1:8877/`。

如果已经下载完整项目，也可以执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-Auto-Voucher-Docker.ps1 -Port 8877
```

## 卸载程序但保留数据

删除容器和本地镜像：

```powershell
docker rm --force auto-voucher
docker image rm ghcr.io/honghudavy-star/auto-voucher:latest
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

Docker Desktop 尚未安装，或者安装后当前 PowerShell 没有刷新环境变量。安装 Docker Desktop 并重新打开 PowerShell。

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

## Docker 版功能边界

Docker 端口默认只绑定到 `127.0.0.1`，不会暴露给局域网。

Linux 容器不能直接调用 Windows 凭据管理器，因此需要保存 AppSecret、访问令牌等密钥的 ERP/OA API 直连暂不适合 Docker 版。文件导入、规则处理、凭证草稿、人工复核和模板导出不受影响。
