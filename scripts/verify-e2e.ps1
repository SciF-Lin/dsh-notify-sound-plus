# ============================================================================
# dsh-notify-sound-plus —— 端到端验证脚本（隔离实例，不碰你正在用的 GUI）
# ============================================================================
# 做法：用全新的 DSH_HOME 起一个干净的 web profile，把插件从本地目录装进去，
#       在另一个端口上引导，然后真的去请求宿主路由、官方 /plugins bundle、
#       以及抓首页确认 boot graph 生效。验证完把整个临时 DSH_HOME 删掉。
#
# 用法： pwsh -File scripts\verify-e2e.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'

$PkgName   = 'dsh-notify-sound-plus'                   # 必须与 package.json 的 name 一致
$PluginDir = Split-Path -Parent $PSScriptRoot          # 插件包根目录
$TempHome  = Join-Path $env:TEMP ('dsh-notify-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$Port      = $null
$Base      = $null
$Server    = $null

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Bad($msg)  { Write-Host "  [FAIL] $msg" -ForegroundColor Red; throw $msg }

# 全局硬超时：任何一步卡住都要能自己结束
$Script:Deadline = (Get-Date).AddSeconds(240)
function Assert-Alive([string]$where) {
  if ((Get-Date) -gt $Script:Deadline) { throw "整体超时（卡在：$where）" }
}

# 找一个真正空闲的端口（直接尝试 bind，而不是只看连接表，避免残留进程占位）
function Find-FreePort([int]$start) {
  for ($p = $start; $p -lt ($start + 20); $p++) {
    try {
      $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $p)
      $l.Start(); $l.Stop()
      return $p
    } catch {}
  }
  throw "找不到空闲端口（从 $start 起试了 20 个）"
}

try {
  Step "1/6 创建隔离 DSH_HOME: $TempHome"
  New-Item -ItemType Directory -Path $TempHome -Force | Out-Null
  $env:DSH_HOME = $TempHome
  Ok "DSH_HOME=$env:DSH_HOME"

  Step "2/6 初始化 verify profile"
  # 注意：**不要**用 `dsh rescue --from-default-profile web` 来建 profile ——
  # 那个命令建完会顺手把 profile 引导起来（见 dsh --help），在脚本里表现为永久阻塞。
  # 这里手写等价的 profile 骨架：package.json + cordis.yml + cordis.patch.yml。
  $ProfDir = Join-Path $TempHome 'profiles\rescue'
  New-Item -ItemType Directory -Path $ProfDir -Force | Out-Null

  $seed = [ordered]@{
    name         = 'dsh-profile-rescue'
    private      = $true
    dependencies = [ordered]@{}
    dsh          = [ordered]@{ profile = [ordered]@{ bundles = @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app') } }
  }
  $seed | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $ProfDir 'package.json') -Encoding UTF8
  '[]' | Set-Content (Join-Path $ProfDir 'cordis.yml') -Encoding UTF8
  # 必须是**顶层 YAML 数组**（空列表），不能是注释或映射
  '[]' | Set-Content (Join-Path $ProfDir 'cordis.patch.yml') -Encoding UTF8
  Ok "profiles\rescue 骨架已创建"

  # 插件路由与首页注入的验证不需要模型后端，但 web 应用引导需要 workspace 存储表。
  # 从用户已有 profile 只拷 storages/（不含凭据，避免复制密钥）。
  $srcStorage = Join-Path $env:USERPROFILE '.dsh\profiles\web\storages'
  if (Test-Path $srcStorage) {
    Copy-Item -Recurse -Force $srcStorage (Join-Path $TempHome 'storages')
    Ok "已借用 storages/（不含凭据）"
  } else {
    New-Item -ItemType Directory -Path (Join-Path $TempHome 'storages') -Force | Out-Null
    Ok "storages/ 为空目录"
  }

  Step "3/6 把插件装进 verify profile（本地 link）"
  & dsh plugin --profile rescue add "link:$PluginDir" 2>&1 | ForEach-Object { "    $_" }
  $pkg = Join-Path $TempHome 'profiles\rescue\package.json'
  $manifest = Get-Content $pkg -Raw | ConvertFrom-Json
  if (-not ($manifest.dsh.profile.bundles -contains $PkgName)) {
    Bad "bundle 列表里没有 $PkgName：$($manifest.dsh.profile.bundles -join ', ')"
  }
  Ok "已进入 bundles: $($manifest.dsh.profile.bundles -join ', ')"

  Step "4/6 引导实例（仅监听回环）"
  $Port = Find-FreePort 19399
  $Base = "http://127.0.0.1:$Port"
  Ok "选用空闲端口 $Port"

  $Server = Start-Process -FilePath 'dsh' `
    -ArgumentList @('--profile', 'rescue', '--port', "$Port", '--host', '127.0.0.1', '--no-open') `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput (Join-Path $TempHome 'out.log') `
    -RedirectStandardError  (Join-Path $TempHome 'err.log')

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    Assert-Alive '等待实例就绪'
    Start-Sleep -Milliseconds 700
    if ($Server.HasExited) {
      Write-Host (Get-Content (Join-Path $TempHome 'err.log') -Raw)
      Write-Host (Get-Content (Join-Path $TempHome 'out.log') -Raw)
      Bad "实例提前退出，退出码 $($Server.ExitCode)"
    }
    try {
      $r = Invoke-WebRequest -Uri "$Base/dsh-notify/state" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { Bad "等待实例就绪超时" }
  Ok "实例已就绪"

  Step "5/7 验证宿主路由与出声判定"
  $st = Invoke-RestMethod -Uri "$Base/dsh-notify/state" -TimeoutSec 5
  if ($st.diagnostics.plugin -ne 'dsh-notify-sound-plus') { Bad "state 不是本插件返回的: $($st.diagnostics.plugin)" }
  if ($st.seq -ne 0) { Bad "初始 seq 应为 0，实际 $($st.seq)" }
  if ($st.diagnostics.routeErrors.Count -gt 0) { Bad "路由注册报错: $($st.diagnostics.routeErrors | ConvertTo-Json -Compress)" }
  Ok "GET /dsh-notify/state -> seq=$($st.seq) mode=$($st.mode) muted=$($st.muted)"

  # 自检：ping 一次，应当让 seq 前进并且 sound 是一个真实声音（不是 none）
  $ping = Invoke-RestMethod -Uri "$Base/dsh-notify/ping" -Method POST -TimeoutSec 5
  if (-not $ping.ok) { Bad "ping 未返回 ok" }
  if ($ping.sound -eq 'none') { Bad "未静音时 ping 的 sound 不该是 none" }
  Ok "POST /dsh-notify/ping -> seq=$($ping.seq) kind=$($ping.kind) sound=$($ping.sound)"

  # 临时静音：静音后新通知必须是 none
  Invoke-RestMethod -Uri "$Base/dsh-notify/mute.json" -Method POST -ContentType 'application/json' -Body '{"muted":true}' -TimeoutSec 5 | Out-Null
  $muted = Invoke-RestMethod -Uri "$Base/dsh-notify/ping" -Method POST -TimeoutSec 5
  if ($muted.sound -ne 'none') { Bad "静音后 sound 应为 none，实际 $($muted.sound)" }
  Ok "静音生效：sound=$($muted.sound)"
  # force 必须能绕过静音（自检/试听要用）
  $forced = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?force=1" -Method POST -TimeoutSec 5
  if ($forced.sound -eq 'none') { Bad "force=1 应绕过静音" }
  Ok "force=1 绕过静音：sound=$($forced.sound)"
  Invoke-RestMethod -Uri "$Base/dsh-notify/mute.json" -Method POST -ContentType 'application/json' -Body '{"muted":false}' -TimeoutSec 5 | Out-Null

  # 模式 off → none；改回 on
  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -ContentType 'application/json' -Body '{"mode":"off"}' -TimeoutSec 5 | Out-Null
  $off = Invoke-RestMethod -Uri "$Base/dsh-notify/ping" -Method POST -TimeoutSec 5
  if ($off.sound -ne 'none') { Bad "mode=off 时 sound 应为 none，实际 $($off.sound)" }
  Ok "mode=off 生效：sound=$($off.sound)"

  # 逐事件选音 + 深合并（改 done 不能把 question 一起抹了）
  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -TimeoutSec 5 `
    -ContentType 'application/json' `
    -Body '{"mode":"on","events":{"done":{"sound":"preset:bell"},"question":{"on":false}}}' | Out-Null
  $bell = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=done" -Method POST -TimeoutSec 5
  if ($bell.sound -ne 'preset:bell') { Bad "选了 preset:bell 后 sound 应为它，实际 $($bell.sound)" }
  Ok "逐事件选音生效：done -> $($bell.sound)"
  $q = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=question" -Method POST -TimeoutSec 5
  if ($q.sound -ne 'none') { Bad "question 关掉后应为 none，实际 $($q.sound)" }
  Ok "逐事件开关生效：question -> $($q.sound)"

  $back = Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -TimeoutSec 5
  if ($back.settings.events.question.on -ne $false) { Bad "question 的 on=false 没有被持久化" }
  if ($back.settings.events.done.sound -ne 'preset:bell') { Bad "done 的音没有被持久化" }

  # —— 系统通知：默认关 → 打开总开关后按事件弹；与静音是两条独立通道 ——
  $defSys = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=question" -Method POST -TimeoutSec 5
  if ($defSys.notify -ne $false) { Bad "系统通知总开关默认应为关，实际 notify=$($defSys.notify)" }
  Ok "系统通知默认关闭：notify=$($defSys.notify)"

  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -TimeoutSec 5 `
    -ContentType 'application/json' -Body '{"system":{"enabled":true}}' | Out-Null
  $onQ = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=question" -Method POST -TimeoutSec 5
  if ($onQ.notify -ne $true) { Bad "打开总开关后 question 的 notify 应为 true，实际 $($onQ.notify)" }
  $onDone = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=done" -Method POST -TimeoutSec 5
  if ($onDone.notify -ne $false) { Bad "done 的系统通知默认应为关，实际 $($onDone.notify)" }
  Ok "系统通知按事件生效：question=$($onQ.notify) done=$($onDone.notify)"

  # 深合并：只改 events 不能把 enabled 抹掉
  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -TimeoutSec 5 `
    -ContentType 'application/json' -Body '{"system":{"events":{"error":true}}}' | Out-Null
  $sysBack = Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -TimeoutSec 5
  if ($sysBack.settings.system.enabled -ne $true) { Bad "system.enabled 被后续写入抹掉了" }
  if ($sysBack.settings.system.events.error -ne $true) { Bad "system.events.error 没写进去" }
  Ok "系统通知设置深合并正确（enabled 保留、error 写入）"

  # 临时静音不该吞掉系统通知
  Invoke-RestMethod -Uri "$Base/dsh-notify/mute.json" -Method POST -ContentType 'application/json' -Body '{"muted":true}' -TimeoutSec 5 | Out-Null
  $mutedNotify = Invoke-RestMethod -Uri "$Base/dsh-notify/ping?kind=question" -Method POST -TimeoutSec 5
  if ($mutedNotify.sound -ne 'none') { Bad "静音后 sound 应为 none" }
  if ($mutedNotify.notify -ne $true) { Bad "静音不该影响系统通知，实际 notify=$($mutedNotify.notify)" }
  Ok "两条通道独立：静音时 sound=$($mutedNotify.sound) 而 notify=$($mutedNotify.notify)"
  Invoke-RestMethod -Uri "$Base/dsh-notify/mute.json" -Method POST -ContentType 'application/json' -Body '{"muted":false}' -TimeoutSec 5 | Out-Null

  # 复位，避免影响后续断言
  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -TimeoutSec 5 `
    -ContentType 'application/json' -Body '{"system":{"enabled":false,"events":{"error":false}}}' | Out-Null
  Ok "设置持久化到 $($back.settings | ConvertTo-Json -Compress)"

  # 声音目录 + 自定义音频上传/取回/删除
  $sounds = Invoke-RestMethod -Uri "$Base/dsh-notify/sounds.json" -TimeoutSec 5
  if ($sounds.builtin.Count -lt 5) { Bad "内置音效目录过少: $($sounds.builtin.Count)" }
  Ok "GET /dsh-notify/sounds.json -> 内置 $($sounds.builtin.Count) 个、自定义 $($sounds.custom.Count) 个"

  # 造一个极小但合法的 WAV（44 字节头），验证上传→取回→删除整条链路
  $wav = [byte[]](0x52,0x49,0x46,0x46, 0x24,0x00,0x00,0x00, 0x57,0x41,0x56,0x45, 0x66,0x6D,0x74,0x20,
                  0x10,0x00,0x00,0x00, 0x01,0x00,0x01,0x00, 0x40,0x1F,0x00,0x00, 0x80,0x3E,0x00,0x00,
                  0x02,0x00,0x10,0x00, 0x64,0x61,0x74,0x61, 0x00,0x00,0x00,0x00)
  $up = Invoke-RestMethod -Uri "$Base/dsh-notify/audio" -Method POST -TimeoutSec 10 `
    -ContentType 'application/json' `
    -Body (@{ name = 'e2e-test'; mime = 'audio/wav'; dataBase64 = [Convert]::ToBase64String($wav) } | ConvertTo-Json -Compress)
  if (-not $up.ok) { Bad "上传自定义音频失败: $($up | ConvertTo-Json -Compress)" }
  Ok "上传自定义音频 -> $($up.sound.id) ($($up.sound.bytes) bytes)"

  $sounds2 = Invoke-RestMethod -Uri "$Base/dsh-notify/sounds.json" -TimeoutSec 5
  if ($sounds2.custom.Count -ne 1) { Bad "上传后自定义音效应为 1 个，实际 $($sounds2.custom.Count)" }
  Ok "自定义音效已出现在目录里：$($sounds2.custom[0].name)"

  $audioRaw = Invoke-WebRequest -Uri "$Base$($up.sound.url)" -UseBasicParsing -TimeoutSec 5
  if ($audioRaw.StatusCode -ne 200) { Bad "取回音频状态码 $($audioRaw.StatusCode)" }
  if ($audioRaw.Headers['Content-Type'] -notmatch 'audio/wav') { Bad "音频 Content-Type 不对: $($audioRaw.Headers['Content-Type'])" }
  if ($audioRaw.RawContentLength -ne $wav.Length) { Bad "取回长度不符：$($audioRaw.RawContentLength) vs $($wav.Length)" }
  Ok "取回音频字节一致（$($audioRaw.RawContentLength) bytes, $($audioRaw.Headers['Content-Type'])）"

  # 非法格式必须被拒
  $rejected = $false
  try {
    Invoke-RestMethod -Uri "$Base/dsh-notify/audio" -Method POST -TimeoutSec 10 `
      -ContentType 'application/json' `
      -Body (@{ name='bad'; mime='application/zip'; dataBase64=[Convert]::ToBase64String($wav) } | ConvertTo-Json -Compress) | Out-Null
  } catch { $rejected = $true }
  if (-not $rejected) { Bad "非音频 mime 应被拒绝" }
  Ok "非音频 mime 被拒绝"

  $upId = [string]$up.sound.id -replace '^custom:', ''
  Invoke-RestMethod -Uri "$Base/dsh-notify/audio/$upId" -Method DELETE -TimeoutSec 5 | Out-Null
  $gone = $false
  try { Invoke-WebRequest -Uri "$Base/dsh-notify/audio/$upId" -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { $gone = $true }
  if (-not $gone) { Bad "删除后音频仍可访问" }
  Ok "删除自定义音频生效"

  # 把设置还原成默认，避免影响后续断言
  Invoke-RestMethod -Uri "$Base/dsh-notify/settings.json" -Method POST -TimeoutSec 5 `
    -ContentType 'application/json' `
    -Body '{"mode":"on","events":{"done":{"on":true,"sound":"default:done"},"question":{"on":true,"sound":"default:question"}}}' | Out-Null

  Step "6/7 验证首页 boot graph"
  # 首页受 dsh 的浏览器鉴权保护（无 token 会 401，而且那个失败响应会挂很久），
  # 所以必须带上 `dsh web` 启动时打印的那个 token。
  $logText = Get-Content (Join-Path $TempHome 'out.log') -Raw -ErrorAction SilentlyContinue
  $mTok = [regex]::Match($logText, '\?token=([A-Za-z0-9_\-]+)')
  if (-not $mTok.Success) { Bad "没能从启动输出里读到首页 token" }
  $token = $mTok.Groups[1].Value
  Ok "已取得首页 token（长度 $($token.Length)）"

  $html = (Invoke-WebRequest -Uri "$Base/?token=$token" -UseBasicParsing -TimeoutSec 20).Content
  # 客户端模块系统把 boot graph 作为 window.__DSH_BOOT__ 注入 <head>；
  # 插件行必须出现在里面，否则页面根本不会去加载我们的 client.js。
  if ($html -notmatch '__DSH_BOOT__') { Bad "首页 HTML 里没有 __DSH_BOOT__（客户端模块系统没生效）" }
  Ok "首页 HTML 含 __DSH_BOOT__"
  if ($html -notmatch [regex]::Escape($PkgName)) { Bad "boot graph 里没有 $PkgName 条目" }
  Ok "boot graph 已包含 $PkgName"

  Step "7/7 验证官方客户端模块通道（/plugins）"
  # bundle 的 URL 带 rev 参数（由文件 mtime/ctime/size 推出），外部猜不出来，
  # 必须从 boot graph 里把真实 URL 抠出来再请求 —— 这也正是页面的实际路径。
  #
  # boot graph 的真实形状（实测）：
  #   globalThis["__DSH_BOOT__"] = {"rev":"…","entries":[
  #       {"id":"<pkg>","url":"plugins/??<pkg>/client.js&rev=<rev>","rev":"…",…}, …],
  #     "batches":[{"descriptor":{"phase":…,"url":…},…}]}
  # url 是**文档相对**形式（去掉了开头 "/"），且 HTML 里 & 被转义成 &amp;。
  # 先按 entry 的 (id → url) 精确取；取不到再用 batches 里的 combo URL 兜底。
  $mEntry = [regex]::Match($html, '"id"\s*:\s*"' + [regex]::Escape($PkgName) + '"\s*,\s*"url"\s*:\s*"([^"]+)"')
  $cand = $null
  if ($mEntry.Success) {
    $cand = $mEntry.Groups[1].Value
    Ok "从 boot graph entry 精确取得 url"
  } else {
    foreach ($m in [regex]::Matches($html, '"url"\s*:\s*"([^"]{1,3000})"')) {
      $v = $m.Groups[1].Value
      if ($v -like '*plugins*' -and $v -like "*$PkgName*") { $cand = $v; break }
    }
    if ($cand) { Ok "从 combo URL 取得 url（我们的 client.js 在同一批里）" }
  }
  if (-not $cand) {
    $snippet = ''
    $idx = $html.IndexOf($PkgName)
    if ($idx -ge 0) { $snippet = $html.Substring([Math]::Max(0, $idx - 300), [Math]::Min(700, $html.Length - [Math]::Max(0, $idx - 300))) }
    Bad "boot graph 里找不到指向 $PkgName 的资源 URL。`n      包名附近片段：`n      $snippet"
  }
  # HTML 实体还原，否则请求会带 &amp; 而 404
  $cand = $cand -replace '&amp;', '&'
  Ok "boot graph 中的资源 URL: $cand"

  # 只取我们自己的单资源 URL 来验证（combo 里含别的包，内容不好断言）
  $single = "plugins/??$PkgName/client.js"
  $targets = @()
  if ($cand -like "*$single*") { $targets += $cand }
  # 无论 combo 命中与否，都按 entry 形再拼一个规范 URL 试一次
  $revM = [regex]::Match($cand, 'rev=([0-9a-f]+)')
  if ($revM.Success) { $targets += "$single&rev=$($revM.Groups[1].Value)" }
  $targets += $single

  $bundle = $null
  $tried = @()
  foreach ($piece in $targets) {
    $fetchUrl = "$Base/" + ($piece -replace '^\.?/', '')
    try {
      $r = Invoke-WebRequest -Uri $fetchUrl -UseBasicParsing -TimeoutSec 15
      $tried += "$fetchUrl -> $($r.StatusCode) ($($r.RawContentLength) bytes)"
      if ($r.StatusCode -eq 200 -and $r.Content -match '__ModuleLoader__') { $bundle = $r; $usedUrl = $fetchUrl; break }
    } catch { $tried += "$fetchUrl -> $($_.Exception.Message)" }
  }
  if (-not $bundle) { Bad "取不到客户端 bundle。尝试记录：`n      $($tried -join "`n      ")" }
  Ok "GET $usedUrl -> 200, $($bundle.RawContentLength) bytes, 含 __ModuleLoader__ 工厂"
  if ($bundle.Content -notmatch [regex]::Escape($PkgName)) { Bad "bundle 内容里没有包名 $PkgName" }
  if ($bundle.Content -notmatch 'settings\.general\.item') { Bad "bundle 里没有注册 settings.general.item" }
  if ($bundle.Content -notmatch 'conversation\.input\.left') { Bad "bundle 里没有注册 conversation.input.left" }
  Ok "bundle 含两个 slot 注册 + 包名（确认 UI 入口会被页面挂载）"

  Write-Host "`n全部通过。" -ForegroundColor Green
}
finally {
  Step "清理"
  # ⚠️ 只 Stop-Process `$Server.Id` 是不够的：Start-Process 拿到的是 dsh.cmd 这个
  #    命令壳，真正监听端口的是它拉起的 "DeepSeek Harness.exe" 子进程；杀了壳，
  #    子进程会变成孤儿继续占着端口（实测漏过好几次）。所以按端口找到真正的
  #    持有者再杀，最后再扫一遍 rescue 实例兜底。
  if ($Port) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      try {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
        Ok "已停止监听 $Port 的进程 (pid $($c.OwningProcess))"
      } catch {}
    }
  }
  if ($Server -and -not $Server.HasExited) {
    Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue
    Ok "已停止命令壳 (pid $($Server.Id))"
  }
  Start-Sleep -Milliseconds 600
  # 兜底：任何还在跑 --profile rescue 的实例都说明是我们漏下的
  $leftover = @(Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '--expose-internals' -and $_.CommandLine -match '--profile\s+rescue\s+--port' })
  foreach ($p in $leftover) {
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    Ok "已清理残留实例 (pid $($p.ProcessId))"
  }
  if ($leftover.Count -eq 0) { Ok "无残留实例" }

  # 确保路径就是我们要删的那个临时目录才动手
  if ($TempHome -and $TempHome.StartsWith($env:TEMP) -and (Test-Path $TempHome)) {
    # 进程刚退出时日志文件可能还被句柄占着，重试几次
    for ($i = 0; $i -lt 5; $i++) {
      Remove-Item -Recurse -Force $TempHome -ErrorAction SilentlyContinue
      if (-not (Test-Path $TempHome)) { break }
      Start-Sleep -Milliseconds 400
    }
    if (Test-Path $TempHome) { Write-Host "  [warn] 临时目录未完全删除: $TempHome" -ForegroundColor Yellow }
    else { Ok "已删除 $TempHome" }
  }
}
