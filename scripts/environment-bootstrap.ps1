param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [ValidateSet("Serve", "Install", "Update")]
    [string]$Mode = "Serve",
    [int]$Port = 18764,
    [string]$AppUrl = "http://127.0.0.1:8765/",
    [string]$Status = "launching",
    [string]$Message = "preparing_application",
    [switch]$ExitWhenTerminal
)

$ErrorActionPreference = "Stop"
$nodeVersion = "22.23.1"
$pythonVersion = "3.12.10"
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeArchiveUrl = "https://mirrors.ustc.edu.cn/node/v$nodeVersion/$nodeArchiveName"
$nodeArchiveSha256 = "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29"
$uvVersion = "0.11.32"
$uvArchiveName = "uv-x86_64-pc-windows-msvc.zip"
$uvArchiveUrl = "https://files.m.daocloud.io/github.com/astral-sh/uv/releases/download/$uvVersion/$uvArchiveName"
$uvArchiveSha256 = "acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984"

$runtimeDirectory = Join-Path $Root ".auto-voucher-runtime"
$toolsDirectory = Join-Path $Root ".auto-voucher-tools"
$downloadsDirectory = Join-Path $runtimeDirectory "downloads"
$statePath = Join-Path $runtimeDirectory "environment-state.json"
$stateTemporaryPath = Join-Path $runtimeDirectory "environment-state.$($PID).tmp"
$stateBackupPath = Join-Path $runtimeDirectory "environment-state.$($PID).bak"
$readyPath = Join-Path $runtimeDirectory "environment-ready"
$environmentCommandPath = Join-Path $runtimeDirectory "environment.cmd"
$serverPidPath = Join-Path $runtimeDirectory "environment-server.pid"
$installPidPath = Join-Path $runtimeDirectory "environment-install.pid"
$logPath = Join-Path $runtimeDirectory "environment-bootstrap.log"
$scriptPath = $MyInvocation.MyCommand.Path
$nodeDirectory = Join-Path $toolsDirectory "node-v$nodeVersion-win-x64"
$localNodePath = Join-Path $nodeDirectory "node.exe"
$uvDirectory = Join-Path $toolsDirectory "uv-$uvVersion"
$localUvPath = Join-Path $uvDirectory "uv.exe"
$pythonDirectory = Join-Path $toolsDirectory "python"
$pythonBinDirectory = Join-Path $toolsDirectory "python-bin"
$uvCacheDirectory = Join-Path $runtimeDirectory "uv-cache"

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

function Write-BootstrapLog {
    param([string]$Text)
    $timestamp = [DateTimeOffset]::Now.ToString("yyyy-MM-dd HH:mm:ss zzz")
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Text" -Encoding UTF8
}

function Write-State {
    param(
        [string]$CurrentStatus,
        [string]$CurrentMessage,
        [string]$NodeStatus,
        [string]$PythonStatus,
        [bool]$Retryable = $false,
        [string]$Detail = ""
    )
    $payload = [ordered]@{
        status = $CurrentStatus
        message = $CurrentMessage
        node = $NodeStatus
        python = $PythonStatus
        retryable = $Retryable
        detail = $Detail
        updatedAt = [DateTimeOffset]::UtcNow.ToString("o")
    }
    $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $stateTemporaryPath -Encoding UTF8
    foreach ($attempt in 1..20) {
        try {
            if (Test-Path -LiteralPath $statePath) {
                if (Test-Path -LiteralPath $stateBackupPath) {
                    Remove-Item -LiteralPath $stateBackupPath -Force
                }
                [IO.File]::Replace($stateTemporaryPath, $statePath, $stateBackupPath)
                Remove-Item -LiteralPath $stateBackupPath -Force -ErrorAction SilentlyContinue
            } else {
                [IO.File]::Move($stateTemporaryPath, $statePath)
            }
            return
        } catch {
            if ($attempt -eq 20) {
                throw
            }
            Start-Sleep -Milliseconds 50
        }
    }
}

function Test-NodePath {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $version = (& $Path -p "process.versions.node" 2>$null | Select-Object -First 1).Trim()
        $major = [int]($version.Split(".")[0])
        if ($major -ge 20) {
            return [pscustomobject]@{ Ready = $true; Path = $Path; Version = $version }
        }
    } catch {
    }
    return $null
}

function Get-NodeInfo {
    $local = Test-NodePath $localNodePath
    if ($null -ne $local) {
        return $local
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        $system = Test-NodePath $command.Source
        if ($null -ne $system) {
            return $system
        }
    }
    return [pscustomobject]@{ Ready = $false; Path = ""; Version = "" }
}

function Test-PythonPath {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }
    try {
        $version = (& $Path -c "import sys; print('.'.join(map(str, sys.version_info[:3])))" 2>$null | Where-Object { $_ -match "^\d+\.\d+\.\d+$" } | Select-Object -First 1)
        if ($version -and ([version]$version -ge [version]"3.11.0")) {
            return [pscustomobject]@{ Ready = $true; Path = $Path; Version = $version }
        }
    } catch {
    }
    return $null
}

function Get-PythonInfo {
    $candidates = @()
    if (Test-Path -LiteralPath $pythonDirectory -PathType Container) {
        $candidates += @(Get-ChildItem -LiteralPath $pythonDirectory -Filter "python.exe" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    }
    $candidates += @(
        (Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"),
        (Join-Path $env:ProgramFiles "Python312\python.exe")
    )
    foreach ($candidate in $candidates) {
        $result = Test-PythonPath $candidate
        if ($null -ne $result) {
            return $result
        }
    }
    $command = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
        $result = Test-PythonPath $command.Source
        if ($null -ne $result) {
            return $result
        }
    }
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $launcher) {
        try {
            $resolved = (& $launcher.Source -3.12 -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1).Trim()
            $result = Test-PythonPath $resolved
            if ($null -ne $result) {
                return $result
            }
        } catch {
        }
    }
    return [pscustomobject]@{ Ready = $false; Path = ""; Version = "" }
}

function Download-VerifiedFile {
    param(
        [string]$Url,
        [string]$ExpectedSha256,
        [string]$Destination
    )
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 300
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256) {
        Remove-Item -LiteralPath $Destination -Force
        throw "Downloaded file checksum mismatch"
    }
}

function Install-LocalNode {
    $archivePath = Join-Path $downloadsDirectory $nodeArchiveName
    Write-BootstrapLog "Downloading verified Node.js $nodeVersion"
    Download-VerifiedFile -Url $nodeArchiveUrl -ExpectedSha256 $nodeArchiveSha256 -Destination $archivePath
    if (Test-Path -LiteralPath $nodeDirectory) {
        Remove-Item -LiteralPath $nodeDirectory -Recurse -Force
    }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $toolsDirectory -Force
    Remove-Item -LiteralPath $archivePath -Force
    $result = Test-NodePath $localNodePath
    if ($null -eq $result) {
        throw "Local Node.js validation failed"
    }
    return $result
}

function Install-LocalPython {
    $archivePath = Join-Path $downloadsDirectory $uvArchiveName
    if (-not (Test-Path -LiteralPath $localUvPath -PathType Leaf)) {
        Write-BootstrapLog "Downloading verified uv $uvVersion"
        Download-VerifiedFile -Url $uvArchiveUrl -ExpectedSha256 $uvArchiveSha256 -Destination $archivePath
        if (Test-Path -LiteralPath $uvDirectory) {
            Remove-Item -LiteralPath $uvDirectory -Recurse -Force
        }
        New-Item -ItemType Directory -Path $uvDirectory -Force | Out-Null
        Expand-Archive -LiteralPath $archivePath -DestinationPath $uvDirectory -Force
        Remove-Item -LiteralPath $archivePath -Force
    }
    if (-not (Test-Path -LiteralPath $localUvPath -PathType Leaf)) {
        throw "Local uv validation failed"
    }
    New-Item -ItemType Directory -Path $pythonDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $pythonBinDirectory -Force | Out-Null
    New-Item -ItemType Directory -Path $uvCacheDirectory -Force | Out-Null
    $previousPythonInstallDirectory = $env:UV_PYTHON_INSTALL_DIR
    $previousPythonBinDirectory = $env:UV_PYTHON_BIN_DIR
    $previousUvCacheDirectory = $env:UV_CACHE_DIR
    $previousPythonInstallMirror = $env:UV_PYTHON_INSTALL_MIRROR
    try {
        $env:UV_PYTHON_INSTALL_DIR = $pythonDirectory
        $env:UV_PYTHON_BIN_DIR = $pythonBinDirectory
        $env:UV_CACHE_DIR = $uvCacheDirectory
        $env:UV_PYTHON_INSTALL_MIRROR = "https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/"
        Write-BootstrapLog "Installing managed Python $pythonVersion into the project tools directory"
        & $localUvPath python install $pythonVersion --managed-python --no-progress
        if ($LASTEXITCODE -ne 0) {
            throw "uv Python installation exited with code $LASTEXITCODE"
        }
        $resolvedPython = (& $localUvPath python find $pythonVersion --managed-python 2>$null | Select-Object -First 1).Trim()
    } finally {
        $env:UV_PYTHON_INSTALL_DIR = $previousPythonInstallDirectory
        $env:UV_PYTHON_BIN_DIR = $previousPythonBinDirectory
        $env:UV_CACHE_DIR = $previousUvCacheDirectory
        $env:UV_PYTHON_INSTALL_MIRROR = $previousPythonInstallMirror
    }
    $result = Test-PythonPath $resolvedPython
    if ($null -eq $result) {
        throw "Local Python validation failed"
    }
    return $result
}

function Write-EnvironmentCommand {
    param($NodeInfo, $PythonInfo)
    $nodeParent = Split-Path -Parent $NodeInfo.Path
    @(
        "@echo off",
        "set `"PATH=$nodeParent;%PATH%`"",
        "set `"AUTO_VOUCHER_PYTHON_EXE=$($PythonInfo.Path)`"",
        "set `"NPM_CONFIG_REGISTRY=https://registry.npmmirror.com`"",
        "set `"PIP_INDEX_URL=https://mirrors.ustc.edu.cn/pypi/simple`"",
        "set `"UV_DEFAULT_INDEX=https://mirrors.ustc.edu.cn/pypi/simple`"",
        "set `"UV_PYTHON_INSTALL_MIRROR=https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/`""
    ) | Set-Content -LiteralPath $environmentCommandPath -Encoding ASCII
}

function Invoke-Installation {
    if (Test-Path -LiteralPath $readyPath) {
        Remove-Item -LiteralPath $readyPath -Force
    }
    try {
        $node = Get-NodeInfo
        $python = Get-PythonInfo
        Write-State -CurrentStatus "installing" -CurrentMessage "checking_environment" -NodeStatus $(if ($node.Ready) { "ready" } else { "missing" }) -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" })
        if (-not $node.Ready) {
            Write-State -CurrentStatus "installing" -CurrentMessage "installing_node" -NodeStatus "installing" -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" })
            $node = Install-LocalNode
        }
        if (-not $python.Ready) {
            Write-State -CurrentStatus "installing" -CurrentMessage "installing_python" -NodeStatus "ready" -PythonStatus "installing"
            $python = Install-LocalPython
        }
        $node = Get-NodeInfo
        $python = Get-PythonInfo
        if (-not $node.Ready -or -not $python.Ready) {
            throw "Environment validation did not pass after installation"
        }
        Write-EnvironmentCommand -NodeInfo $node -PythonInfo $python
        Set-Content -LiteralPath $readyPath -Value "ready" -Encoding ASCII
        Write-State -CurrentStatus "ready" -CurrentMessage "environment_ready" -NodeStatus "ready" -PythonStatus "ready"
        Write-BootstrapLog "Environment is ready"
        exit 0
    } catch {
        Write-BootstrapLog "Environment installation failed: $($_.Exception.Message)"
        $node = Get-NodeInfo
        $python = Get-PythonInfo
        Write-State -CurrentStatus "error" -CurrentMessage "environment_failed" -NodeStatus $(if ($node.Ready) { "ready" } else { "missing" }) -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" }) -Retryable $true -Detail $_.Exception.Message
        exit 1
    }
}

function Get-PageHtml {
    $safeAppUrl = [System.Net.WebUtility]::HtmlEncode($AppUrl)
    return @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto Voucher &#29615;&#22659;&#37197;&#32622;</title>
  <style>
    :root{color-scheme:light;--ink:#29231f;--muted:#766b63;--paper:#fbf6ef;--panel:#fffdf9;--line:#e5d8cc;--coral:#cf684f;--sage:#466d5c;--amber:#a76c20;--red:#9b4039}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at 88% 10%,#f4d8ca 0,transparent 31%),var(--paper);color:var(--ink);font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}
    main{width:min(880px,calc(100% - 40px));margin:0 auto;padding:clamp(44px,9vh,92px) 0}
    .eyebrow{margin:0 0 18px;color:var(--coral);font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
    h1{margin:0;max-width:700px;font-size:clamp(34px,6vw,64px);font-weight:700;line-height:1.08;letter-spacing:-.04em}
    .lead{max-width:650px;margin:20px 0 42px;color:var(--muted);font-size:17px;line-height:1.75}
    .rail{border-top:1px solid var(--line)}
    .check{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:18px;align-items:center;padding:24px 0;border-bottom:1px solid var(--line)}
    .number{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--line);border-radius:50%;font-size:13px;font-weight:700}
    .check h2{margin:0 0 5px;font-size:17px}.check p{margin:0;color:var(--muted);font-size:14px}
    .badge{min-width:82px;padding:7px 10px;border-radius:999px;text-align:center;font-size:12px;font-weight:700}
    .ready{background:#dce9e1;color:var(--sage)}.missing,.installing{background:#f2e4cf;color:var(--amber)}.failed{background:#f0d8d4;color:var(--red)}
    .activity{display:flex;align-items:flex-start;gap:12px;margin-top:30px;color:var(--muted);font-size:14px;line-height:1.6}
    .pulse{flex:0 0 auto;width:10px;height:10px;margin-top:6px;border-radius:50%;background:var(--coral);animation:pulse 1.3s ease-out infinite}
    button{margin-top:28px;padding:14px 20px;border:0;border-radius:7px;background:var(--ink);color:var(--panel);font:inherit;font-weight:700;cursor:pointer}
    button:hover{background:#443a33}button:focus-visible{outline:3px solid rgba(207,104,79,.35);outline-offset:3px}button:disabled{cursor:wait;opacity:.58}
    .detail{display:none;margin-top:18px;color:var(--red);font-size:13px;line-height:1.6}.detail.visible{display:block}
    footer{margin-top:48px;color:var(--muted);font-size:12px}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(207,104,79,.42)}70%{box-shadow:0 0 0 9px rgba(207,104,79,0)}100%{box-shadow:0 0 0 0 rgba(207,104,79,0)}}
    @media(max-width:620px){.check{grid-template-columns:36px 1fr}.badge{grid-column:2;justify-self:start}.lead{margin-bottom:28px}}
    @media(prefers-reduced-motion:reduce){.pulse{animation:none}}
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Auto Voucher &middot; &#26412;&#22320;&#21551;&#21160;</p>
    <h1>&#21551;&#21160;&#21069;&#65292;&#20808;&#25226;&#29615;&#22659;&#20934;&#22791;&#22909;</h1>
    <p class="lead">&#21482;&#38656;&#28857;&#20987;&#19968;&#27425;&#65292;&#31243;&#24207;&#20250;&#22312;&#39033;&#30446;&#20869;&#37096;&#33258;&#21160;&#37197;&#32622;&#36816;&#34892;&#29615;&#22659;&#65292;&#26816;&#39564;&#25104;&#21151;&#21518;&#32487;&#32493;&#21551;&#21160;&#12290;</p>
    <section class="rail" aria-label="&#29615;&#22659;&#26816;&#27979;&#32467;&#26524;">
      <article class="check">
        <span class="number">01</span>
        <div><h2>Node.js</h2><p>&#29992;&#20110;&#20934;&#22791;&#26412;&#22320;&#32593;&#39029;&#30028;&#38754;</p></div>
        <span class="badge missing" id="node-status">&#26816;&#27979;&#20013;</span>
      </article>
      <article class="check">
        <span class="number">02</span>
        <div><h2>Python</h2><p>&#29992;&#20110;&#20973;&#35777;&#22788;&#29702;&#12289;OCR &#19982; PDF &#33021;&#21147;</p></div>
        <span class="badge missing" id="python-status">&#26816;&#27979;&#20013;</span>
      </article>
    </section>
    <div class="activity"><span class="pulse"></span><span id="message">&#27491;&#22312;&#26816;&#27979;&#36825;&#21488;&#30005;&#33041;</span></div>
    <button id="action" type="button">&#33258;&#21160;&#23433;&#35013;&#29615;&#22659;&#24182;&#32487;&#32493;</button>
    <p class="detail" id="detail"></p>
    <footer>&#19981;&#20250;&#23433;&#35013;&#21040;&#20844;&#21496;&#26381;&#21153;&#22120;&#65292;&#19981;&#20250;&#19978;&#20256;&#19994;&#21153;&#25968;&#25454;&#12290;</footer>
  </main>
  <script>
    const appUrl = "$safeAppUrl";
    const labels = {
      ready: "\u5df2\u5c31\u7eea",
      missing: "\u5f85\u914d\u7f6e",
      installing: "\u6b63\u5728\u914d\u7f6e",
      failed: "\u914d\u7f6e\u5931\u8d25"
    };
    const messages = {
      ready_to_install: "\u68c0\u6d4b\u5b8c\u6210\uff0c\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u81ea\u52a8\u914d\u7f6e",
      environment_detected: "\u73af\u5883\u5df2\u5c31\u7eea\uff0c\u70b9\u51fb\u540e\u7ee7\u7eed\u542f\u52a8",
      checking_environment: "\u6b63\u5728\u590d\u6838\u672c\u673a\u73af\u5883",
      installing_node: "\u6b63\u5728\u5b89\u88c5\u5e76\u6821\u9a8c Node.js\uff0c\u8bf7\u4fdd\u6301\u7f51\u7edc\u8fde\u63a5",
      installing_python: "\u6b63\u5728\u5b89\u88c5\u5e76\u6821\u9a8c Python\uff0c\u8bf7\u4fdd\u6301\u7f51\u7edc\u8fde\u63a5",
      environment_ready: "\u73af\u5883\u5df2\u6210\u529f\uff0c\u6b63\u5728\u7ee7\u7eed\u542f\u52a8 Auto Voucher",
      checking_source_update: "\u73af\u5883\u5df2\u6210\u529f\uff0c\u6b63\u5728\u68c0\u67e5\u6e90\u7801\u66f4\u65b0",
      creating_python_environment: "\u6b63\u5728\u521b\u5efa Auto Voucher \u4e13\u7528\u73af\u5883",
      installing_components: "\u6b63\u5728\u51c6\u5907 Core\u3001OCR \u548c PDF \u7ec4\u4ef6",
      preparing_web_interface: "\u6b63\u5728\u51c6\u5907\u672c\u5730\u7f51\u9875\u754c\u9762",
      starting_local_service: "\u6b63\u5728\u542f\u52a8\u672c\u5730 Auto Voucher \u670d\u52a1",
      application_ready: "Auto Voucher \u5df2\u5c31\u7eea\uff0c\u6b63\u5728\u8fdb\u5165\u5de5\u4f5c\u53f0",
      environment_failed: "\u81ea\u52a8\u914d\u7f6e\u6ca1\u6709\u5b8c\u6210\uff0c\u53ef\u76f4\u63a5\u91cd\u8bd5",
      setup_failed: "\u7a0b\u5e8f\u51c6\u5907\u6ca1\u6709\u5b8c\u6210\uff0c\u8bf7\u4fdd\u7559\u9875\u9762\u548c\u65e5\u5fd7\u8fdb\u884c\u6392\u67e5",
      server_failed: "\u672c\u5730\u670d\u52a1\u672a\u80fd\u6b63\u5e38\u542f\u52a8"
    };
    const action = document.querySelector("#action");
    const message = document.querySelector("#message");
    const detail = document.querySelector("#detail");
    let currentStatus = "";

    function updateBadge(id, state) {
      const element = document.querySelector(id);
      element.className = "badge " + (state === "error" ? "failed" : state);
      element.textContent = labels[state] || labels.missing;
    }

    async function refresh() {
      try {
        const state = await fetch("/api/status", { cache: "no-store" }).then((response) => response.json());
        currentStatus = state.status;
        updateBadge("#node-status", state.node);
        updateBadge("#python-status", state.python);
        message.textContent = messages[state.message] || state.message || messages.ready_to_install;
        detail.textContent = state.detail || "";
        detail.classList.toggle("visible", Boolean(state.detail));
        const working = ["installing", "updating", "configuring", "starting", "ready", "launching"].includes(state.status);
        action.disabled = working;
        action.hidden = working && !state.retryable;
        action.textContent = state.retryable ? "\u91cd\u8bd5\u81ea\u52a8\u914d\u7f6e" : "\u81ea\u52a8\u5b89\u88c5\u73af\u5883\u5e76\u7ee7\u7eed";
        if (["ready", "launching", "updating", "configuring", "starting"].includes(state.status)) {
          try {
            await fetch(appUrl, { mode: "no-cors", cache: "no-store" });
            location.replace(appUrl);
          } catch {
          }
        }
      } catch {
        message.textContent = "\u672c\u5730\u5f15\u5bfc\u670d\u52a1\u6b63\u5728\u51c6\u5907\uff0c\u8bf7\u7a0d\u5019";
      }
    }

    action.addEventListener("click", async () => {
      action.disabled = true;
      detail.classList.remove("visible");
      message.textContent = "\u5df2\u5f00\u59cb\u81ea\u52a8\u914d\u7f6e\uff0c\u9996\u6b21\u8fd0\u884c\u53ef\u80fd\u9700\u8981\u51e0\u5206\u949f";
      try {
        await fetch("/api/install", { method: "POST" });
      } catch {
        action.disabled = false;
      }
      await refresh();
    });

    refresh();
    setInterval(refresh, 1200);
  </script>
</body>
</html>
"@
}

function Send-Response {
    param(
        $Stream,
        [int]$StatusCode,
        [string]$ContentType,
        [string]$Body
    )
    $reason = if ($StatusCode -eq 200) { "OK" } elseif ($StatusCode -eq 202) { "Accepted" } elseif ($StatusCode -eq 404) { "Not Found" } else { "Error" }
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $header = "HTTP/1.1 $StatusCode $reason`r`nContent-Type: $ContentType; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    $Stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $Stream.Flush()
}

function Start-InstallProcess {
    if (Test-Path -LiteralPath $installPidPath) {
        $existingPid = [int](Get-Content -LiteralPath $installPidPath -Raw)
        if ($null -ne (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
            return
        }
    }
    $node = Get-NodeInfo
    $python = Get-PythonInfo
    Write-State -CurrentStatus "installing" -CurrentMessage "checking_environment" -NodeStatus $(if ($node.Ready) { "ready" } else { "missing" }) -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" })
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", "`"$scriptPath`"",
        "-Root", "`"$Root`"",
        "-Mode", "Install",
        "-Port", "$Port",
        "-AppUrl", "`"$AppUrl`""
    )
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Set-Content -LiteralPath $installPidPath -Value $process.Id -Encoding ASCII
}

function Start-BootstrapServer {
    if (Test-Path -LiteralPath $readyPath) {
        Remove-Item -LiteralPath $readyPath -Force
    }
    if (Test-Path -LiteralPath $environmentCommandPath) {
        Remove-Item -LiteralPath $environmentCommandPath -Force
    }
    $node = Get-NodeInfo
    $python = Get-PythonInfo
    $messageKey = if ($node.Ready -and $python.Ready) { "environment_detected" } else { "ready_to_install" }
    Write-State -CurrentStatus "waiting" -CurrentMessage $messageKey -NodeStatus $(if ($node.Ready) { "ready" } else { "missing" }) -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" }) -Retryable $true
    Set-Content -LiteralPath $serverPidPath -Value $PID -Encoding ASCII
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    Write-BootstrapLog "Environment bootstrap server started on 127.0.0.1:$Port"
    try {
        while ($true) {
            $client = $listener.AcceptTcpClient()
            try {
                $stream = $client.GetStream()
                $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
                $requestLine = $reader.ReadLine()
                if (-not $requestLine) {
                    continue
                }
                while ($true) {
                    $line = $reader.ReadLine()
                    if ($null -eq $line -or $line.Length -eq 0) {
                        break
                    }
                }
                $parts = $requestLine.Split(" ")
                $method = $parts[0]
                $path = $parts[1]
                if ($method -eq "GET" -and $path -eq "/") {
                    Send-Response -Stream $stream -StatusCode 200 -ContentType "text/html" -Body (Get-PageHtml)
                } elseif ($method -eq "GET" -and $path -eq "/api/status") {
                    $body = if (Test-Path -LiteralPath $statePath) { Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 } else { "{}" }
                    Send-Response -Stream $stream -StatusCode 200 -ContentType "application/json" -Body $body
                } elseif ($method -eq "POST" -and $path -eq "/api/install") {
                    Start-InstallProcess
                    Send-Response -Stream $stream -StatusCode 202 -ContentType "application/json" -Body '{"accepted":true}'
                } else {
                    Send-Response -Stream $stream -StatusCode 404 -ContentType "application/json" -Body '{"error":"not_found"}'
                }
            } catch {
                Write-BootstrapLog "Request failed: $($_.Exception.Message)"
            } finally {
                $client.Close()
            }
            if ($ExitWhenTerminal -and (Test-Path -LiteralPath $statePath)) {
                $currentState = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($currentState.status -in @("ready", "error")) {
                    break
                }
            }
        }
    } finally {
        $listener.Stop()
        if (Test-Path -LiteralPath $stateTemporaryPath) {
            Remove-Item -LiteralPath $stateTemporaryPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $stateBackupPath) {
            Remove-Item -LiteralPath $stateBackupPath -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($Mode -eq "Install") {
    Invoke-Installation
}

if ($Mode -eq "Update") {
    $node = Get-NodeInfo
    $python = Get-PythonInfo
    $retryable = $false
    Write-State -CurrentStatus $Status -CurrentMessage $Message -NodeStatus $(if ($node.Ready) { "ready" } else { "missing" }) -PythonStatus $(if ($python.Ready) { "ready" } else { "missing" }) -Retryable $retryable
    exit 0
}

Start-BootstrapServer
