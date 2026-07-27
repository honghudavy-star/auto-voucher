param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [Parameter(Mandatory = $true)]
    [ValidateSet("checking", "updating", "configuring", "starting", "ready", "missing_node", "missing_python", "error")]
    [string]$Phase,
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [ValidateSet("checking", "ready", "missing")]
    [string]$NodeStatus = "checking",
    [ValidateSet("checking", "ready", "missing")]
    [string]$PythonStatus = "checking",
    [string]$AppUrl = "http://127.0.0.1:8765/",
    [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$runtimeDirectory = Join-Path $Root ".auto-voucher-runtime"
$outputPath = Join-Path $runtimeDirectory "startup.html"
$temporaryPath = Join-Path $runtimeDirectory "startup.html.tmp"
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null

$phaseCopy = @{
    checking = @("正在检测这台电脑", "先确认运行环境，再开始配置。")
    updating = @("正在检查更新", "本地版本可继续使用，更新失败不会阻止启动。")
    configuring = @("正在准备运行环境", "首次启动需要安装完整组件，请保持网络连接。")
    starting = @("正在启动本地服务", "数据只在这台电脑上处理。")
    ready = @("准备完成", "正在进入 Auto Voucher。")
    missing_node = @("需要安装 Node.js", "安装 Node.js 22 LTS 后，再次双击启动文件。")
    missing_python = @("需要安装 Python", "安装 Python 3.12 后，再次双击启动文件。")
    error = @("启动没有完成", "错误已经保存在本地日志中，可据此准确排查。")
}
$statusCopy = @{
    checking = @("检测中", "pending")
    ready = @("已就绪", "complete")
    missing = @("需要安装", "blocked")
}

$title = $phaseCopy[$Phase][0]
$subtitle = $phaseCopy[$Phase][1]
$nodeLabel = $statusCopy[$NodeStatus][0]
$nodeClass = $statusCopy[$NodeStatus][1]
$pythonLabel = $statusCopy[$PythonStatus][0]
$pythonClass = $statusCopy[$PythonStatus][1]
$safeMessage = [System.Net.WebUtility]::HtmlEncode($Message)
$safeLogPath = [System.Net.WebUtility]::HtmlEncode($LogPath)
$safeAppUrl = [System.Net.WebUtility]::HtmlEncode($AppUrl)
$refresh = if ($Phase -in @("ready", "missing_node", "missing_python", "error")) { "" } else { '<meta http-equiv="refresh" content="2">' }
$redirect = if ($Phase -eq "ready") { "<script>setTimeout(function(){location.replace('$safeAppUrl')},900)</script>" } else { "" }
$nodeAction = if ($Phase -eq "missing_node") { '<a class="action" href="https://nodejs.org/en/download">下载 Node.js 22 LTS</a>' } else { "" }
$pythonAction = if ($Phase -eq "missing_python") { '<a class="action" href="https://www.python.org/downloads/windows/">下载 Python 3.12</a>' } else { "" }
$logSection = if ($Phase -eq "error") {
    "<div class='log'><span>启动日志</span><code>$safeLogPath</code></div>"
} else {
    ""
}

$html = @"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  $refresh
  <title>Auto Voucher 启动检测</title>
  <style>
    :root{color-scheme:light;--ink:#29231f;--muted:#766b63;--paper:#fbf6ef;--panel:#fffdf9;--line:#e5d8cc;--coral:#cf684f;--sage:#466d5c;--amber:#a76c20;--red:#9b4039}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(circle at 88% 10%,#f4d8ca 0,transparent 31%),var(--paper);color:var(--ink);font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}
    main{width:min(880px,calc(100% - 40px));margin:0 auto;padding:clamp(44px,9vh,92px) 0}
    .eyebrow{margin:0 0 18px;color:var(--coral);font-size:13px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}
    h1{margin:0;max-width:660px;font-family:"Microsoft YaHei UI","Segoe UI",sans-serif;font-size:clamp(34px,6vw,64px);font-weight:700;line-height:1.08;letter-spacing:-.04em}
    .lead{max-width:620px;margin:20px 0 42px;color:var(--muted);font-size:17px;line-height:1.75}
    .rail{position:relative;border-top:1px solid var(--line)}
    .check{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:18px;align-items:center;padding:24px 0;border-bottom:1px solid var(--line)}
    .number{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--line);border-radius:50%;font-size:13px;font-weight:700}
    .check h2{margin:0 0 5px;font-size:17px}
    .check p{margin:0;color:var(--muted);font-size:14px}
    .badge{min-width:74px;padding:7px 10px;border-radius:999px;text-align:center;font-size:12px;font-weight:700}
    .complete{background:#dce9e1;color:var(--sage)}.pending{background:#f2e4cf;color:var(--amber)}.blocked{background:#f0d8d4;color:var(--red)}
    .activity{display:flex;align-items:center;gap:12px;margin-top:30px;color:var(--muted);font-size:14px}
    .pulse{width:10px;height:10px;border-radius:50%;background:var(--coral);animation:pulse 1.3s ease-out infinite}
    .action{display:inline-flex;margin-top:28px;padding:13px 18px;background:var(--ink);color:var(--panel);text-decoration:none;font-weight:700;border-radius:6px}
    .log{margin-top:28px;padding:18px 0;border-top:1px solid var(--line)}
    .log span{display:block;margin-bottom:8px;color:var(--muted);font-size:13px}.log code{font-family:Consolas,monospace;font-size:13px;word-break:break-all}
    footer{margin-top:48px;color:var(--muted);font-size:12px}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(207,104,79,.42)}70%{box-shadow:0 0 0 9px rgba(207,104,79,0)}100%{box-shadow:0 0 0 0 rgba(207,104,79,0)}}
    @media(max-width:620px){.check{grid-template-columns:36px 1fr}.badge{grid-column:2;justify-self:start}.lead{margin-bottom:28px}}
    @media(prefers-reduced-motion:reduce){.pulse{animation:none}}
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Auto Voucher · 本地启动</p>
    <h1>$title</h1>
    <p class="lead">$subtitle</p>
    <section class="rail" aria-label="环境检测结果">
      <article class="check">
        <span class="number">01</span>
        <div><h2>Node.js</h2><p>用于准备本地网页界面</p></div>
        <span class="badge $nodeClass">$nodeLabel</span>
      </article>
      <article class="check">
        <span class="number">02</span>
        <div><h2>Python</h2><p>用于凭证处理、OCR 与 PDF 能力</p></div>
        <span class="badge $pythonClass">$pythonLabel</span>
      </article>
    </section>
    <div class="activity"><span class="pulse"></span><span>$safeMessage</span></div>
    $nodeAction
    $pythonAction
    $logSection
    <footer>所有业务数据均保存在本机。关闭此页面不会删除数据。</footer>
  </main>
  $redirect
</body>
</html>
"@

Set-Content -LiteralPath $temporaryPath -Value $html -Encoding UTF8
Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force
