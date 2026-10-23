# Engineered Plans Project Tracker - local web server (Windows PowerShell 5.1+, no installs needed).
# Serves the app ONLY on the loopback interface at the fixed origin http://localhost:4173
# If that port is taken by another program it stops with an explanation (it never switches port).
param(
  [int]$Port = 4173,
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Origin = "http://localhost:$Port/"
$TokenFile = Join-Path $PSScriptRoot '.server-token'

function Test-TrackerRunning {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri ($Origin + '__tracker_ping') -TimeoutSec 2
    return ($r.Content -eq 'engineeredplans-project-tracker')
  } catch { return $false }
}

$listening = $null
try { $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop } catch { $listening = $null }
if ($listening) {
  if (Test-TrackerRunning) {
    Write-Host "Project Tracker is already running at $Origin" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $Origin }
    exit 0
  }
  $procId = ($listening | Select-Object -First 1).OwningProcess
  $procName = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { 'unknown' }
  Write-Host ""
  Write-Host "Port $Port is already in use by another program ($procName, process ID $procId)." -ForegroundColor Red
  Write-Host "The tracker must always use $Origin because the browser keeps your records per address."
  Write-Host "Starting on a different port would show an EMPTY tracker, so the launcher has stopped."
  Write-Host "Close the other program (or free port $Port) and run the launcher again."
  exit 2
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'
  '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'; '.jpg' = 'image/jpeg'; '.webp' = 'image/webp'
}

$token = [guid]::NewGuid().ToString('N')
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($Origin)   # 'localhost' prefix = loopback only, no admin rights required
try { $listener.Start() } catch {
  Write-Host "Could not start the server on $Origin : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Another program may be using port $Port. The launcher will not switch to another port."
  exit 2
}
Set-Content -Path $TokenFile -Value $token -Encoding ascii
Write-Host "Engineered Plans Project Tracker is running at $Origin" -ForegroundColor Green
Write-Host "Keep this window open while you use the tracker. Press Ctrl+C (or run Stop-Project-Tracker.bat) to stop."
Write-Host "Stopping the server never deletes records; they are stored in your browser profile."
if (-not $NoBrowser) { Start-Process $Origin }

$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
try {
  while ($listener.IsListening) {
    $async = $listener.BeginGetContext($null, $null)
    while (-not $async.AsyncWaitHandle.WaitOne(500)) { if (-not $listener.IsListening) { break } }
    if (-not $listener.IsListening) { break }
    $ctx = $listener.EndGetContext($async)
    $req = $ctx.Request; $res = $ctx.Response
    try {
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.Headers.Add('X-Content-Type-Options', 'nosniff')
      $path = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($path -eq '/__tracker_ping') {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('engineeredplans-project-tracker')
        $res.ContentType = 'text/plain'; $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.Close(); continue
      }
      if ($path -eq '/__tracker_shutdown') {
        if ($req.QueryString['token'] -eq $token) { $res.StatusCode = 200; $res.Close(); break }
        $res.StatusCode = 403; $res.Close(); continue
      }
      if ($path.EndsWith('/')) { $path += 'index.html' }
      $rel = $path.TrimStart('/').Replace('/', '\')
      $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
      $name = [System.IO.Path]::GetFileName($full)
      if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or $name.StartsWith('.') -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found')
        $res.OutputStream.Write($bytes, 0, $bytes.Length); $res.Close(); continue
      }
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      if ($req.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      $res.Close()
    } catch {
      try { $res.StatusCode = 500; $res.Close() } catch {}
    }
  }
} finally {
  $listener.Stop(); $listener.Close()
  Remove-Item -LiteralPath $TokenFile -ErrorAction SilentlyContinue
  Write-Host "Project Tracker server stopped. Your records remain in the browser."
}
