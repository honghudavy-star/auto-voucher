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
    checking = @("&#27491;&#22312;&#26816;&#27979;&#36825;&#21488;&#30005;&#33041;", "&#20808;&#30830;&#35748;&#36816;&#34892;&#29615;&#22659;&#65292;&#20877;&#24320;&#22987;&#37197;&#32622;&#12290;")
    updating = @("&#27491;&#22312;&#26816;&#26597;&#26356;&#26032;", "&#26412;&#22320;&#29256;&#26412;&#21487;&#32487;&#32493;&#20351;&#29992;&#65292;&#26356;&#26032;&#22833;&#36133;&#19981;&#20250;&#38459;&#27490;&#21551;&#21160;&#12290;")
    configuring = @("&#27491;&#22312;&#20934;&#22791;&#36816;&#34892;&#29615;&#22659;", "&#39318;&#27425;&#21551;&#21160;&#38656;&#35201;&#23433;&#35013;&#23436;&#25972;&#32452;&#20214;&#65292;&#35831;&#20445;&#25345;&#32593;&#32476;&#36830;&#25509;&#12290;")
    starting = @("&#27491;&#22312;&#21551;&#21160;&#26412;&#22320;&#26381;&#21153;", "&#25968;&#25454;&#21482;&#22312;&#36825;&#21488;&#30005;&#33041;&#19978;&#22788;&#29702;&#12290;")
    ready = @("&#20934;&#22791;&#23436;&#25104;", "&#27491;&#22312;&#36827;&#20837; Auto Voucher&#12290;")
    missing_node = @("&#38656;&#35201;&#23433;&#35013; Node.js", "&#23433;&#35013; Node.js 22 LTS &#21518;&#65292;&#20877;&#27425;&#21452;&#20987;&#21551;&#21160;&#25991;&#20214;&#12290;")
    missing_python = @("&#38656;&#35201;&#23433;&#35013; Python", "&#23433;&#35013; Python 3.12 &#21518;&#65292;&#20877;&#27425;&#21452;&#20987;&#21551;&#21160;&#25991;&#20214;&#12290;")
    error = @("&#21551;&#21160;&#27809;&#26377;&#23436;&#25104;", "&#38169;&#35823;&#24050;&#32463;&#20445;&#23384;&#22312;&#26412;&#22320;&#26085;&#24535;&#20013;&#65292;&#21487;&#25454;&#27492;&#20934;&#30830;&#25490;&#26597;&#12290;")
}
$statusCopy = @{
    checking = @("&#26816;&#27979;&#20013;", "pending")
    ready = @("&#24050;&#23601;&#32490;", "complete")
    missing = @("&#38656;&#35201;&#23433;&#35013;", "blocked")
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
$nodeAction = if ($Phase -eq "missing_node") { '<a class="action" href="https://nodejs.org/en/download">&#19979;&#36733; Node.js 22 LTS</a>' } else { "" }
$pythonAction = if ($Phase -eq "missing_python") { '<a class="action" href="https://www.python.org/downloads/windows/">&#19979;&#36733; Python 3.12</a>' } else { "" }
$logSection = if ($Phase -eq "error") {
    "<div class='log'><span>&#21551;&#21160;&#26085;&#24535;</span><code>$safeLogPath</code></div>"
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
  <title>Auto Voucher &#21551;&#21160;&#26816;&#27979;</title>
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
    <p class="eyebrow">Auto Voucher &middot; &#26412;&#22320;&#21551;&#21160;</p>
    <h1>$title</h1>
    <p class="lead">$subtitle</p>
    <section class="rail" aria-label="&#29615;&#22659;&#26816;&#27979;&#32467;&#26524;">
      <article class="check">
        <span class="number">01</span>
        <div><h2>Node.js</h2><p>&#29992;&#20110;&#20934;&#22791;&#26412;&#22320;&#32593;&#39029;&#30028;&#38754;</p></div>
        <span class="badge $nodeClass">$nodeLabel</span>
      </article>
      <article class="check">
        <span class="number">02</span>
        <div><h2>Python</h2><p>&#29992;&#20110;&#20973;&#35777;&#22788;&#29702;&#12289;OCR &#19982; PDF &#33021;&#21147;</p></div>
        <span class="badge $pythonClass">$pythonLabel</span>
      </article>
    </section>
    <div class="activity"><span class="pulse"></span><span>$safeMessage</span></div>
    $nodeAction
    $pythonAction
    $logSection
    <footer>&#25152;&#26377;&#19994;&#21153;&#25968;&#25454;&#22343;&#20445;&#23384;&#22312;&#26412;&#26426;&#12290;&#20851;&#38381;&#27492;&#39029;&#38754;&#19981;&#20250;&#21024;&#38500;&#25968;&#25454;&#12290;</footer>
  </main>
  $redirect
</body>
</html>
"@

Set-Content -LiteralPath $temporaryPath -Value $html -Encoding UTF8
Move-Item -LiteralPath $temporaryPath -Destination $outputPath -Force
