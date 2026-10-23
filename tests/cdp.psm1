# Minimal Chrome DevTools Protocol client for headless Edge/Chrome (used by the test scripts only).
$script:ws = $null
$script:msgId = 0
$script:proc = $null

function Get-BrowserPath {
  @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
}

function Start-CdpBrowser {
  param([string]$ProfileDir, [int]$DebugPort = 9333, [string]$Url = 'about:blank', [string]$WindowSize = '1366,900')
  $b = Get-BrowserPath
  $script:proc = Start-Process $b -ArgumentList "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=$DebugPort", "--user-data-dir=`"$ProfileDir`"", "--window-size=$WindowSize", $Url -PassThru
  $targets = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    try { $targets = Invoke-RestMethod "http://127.0.0.1:$DebugPort/json" -TimeoutSec 1; if ($targets | Where-Object { $_.type -eq 'page' }) { break } } catch {}
  }
  $page = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  $script:ws = New-Object System.Net.WebSockets.ClientWebSocket
  $script:ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(30)
  $script:ws.ConnectAsync([Uri]$page.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
}

function Receive-CdpMessage {
  $buffer = New-Object byte[] 1048576
  $ms = New-Object System.IO.MemoryStream
  do {
    $seg = New-Object System.ArraySegment[byte] -ArgumentList (, $buffer)
    $r = $script:ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).Result
    $ms.Write($buffer, 0, $r.Count)
  } while (-not $r.EndOfMessage)
  [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
}

function Invoke-Cdp {
  param([string]$Method, [hashtable]$Params = @{})
  $script:msgId++
  $id = $script:msgId
  $json = @{ id = $id; method = $Method; params = $Params } | ConvertTo-Json -Depth 10 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $seg = New-Object System.ArraySegment[byte] -ArgumentList (, $bytes)
  $script:ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $msg = Receive-CdpMessage | ConvertFrom-Json
    if ($msg.id -eq $id) { if ($msg.error) { throw "CDP $Method failed: $($msg.error.message)" }; return $msg.result }
  }
}

# Evaluates JS (awaiting promises) and returns the value.
function Invoke-Js {
  param([string]$Expression)
  $r = Invoke-Cdp 'Runtime.evaluate' @{ expression = $Expression; awaitPromise = $true; returnByValue = $true }
  if ($r.exceptionDetails) { throw "JS error: $($r.exceptionDetails.exception.description)" }
  $r.result.value
}

function Wait-Js {
  param([string]$Condition, [int]$TimeoutSec = 60)
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    try { if (Invoke-Js $Condition) { return $true } } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for: $Condition"
}

function Open-CdpUrl { param([string]$Url) Invoke-Cdp 'Page.navigate' @{ url = $Url } | Out-Null; Start-Sleep -Milliseconds 300; Wait-Js "document.readyState === 'complete'" 30 | Out-Null }

function Save-CdpScreenshot {
  param([string]$Path, [int]$Width = 0, [int]$Height = 0, [switch]$Mobile)
  if ($Width) { Invoke-Cdp 'Emulation.setDeviceMetricsOverride' @{ width = $Width; height = $Height; deviceScaleFactor = 1; mobile = [bool]$Mobile } | Out-Null; Start-Sleep -Milliseconds 400 }
  $r = Invoke-Cdp 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
  [IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($r.data))
}

function Save-CdpPdf {
  param([string]$Path, [bool]$Landscape = $false)
  $r = Invoke-Cdp 'Page.printToPDF' @{ landscape = $Landscape; printBackground = $true; preferCSSPageSize = $true; displayHeaderFooter = $false }
  [IO.File]::WriteAllBytes($Path, [Convert]::FromBase64String($r.data))
}

function Stop-CdpBrowser {
  try { Invoke-Cdp 'Browser.close' | Out-Null } catch {}
  Start-Sleep -Milliseconds 500
  if ($script:proc -and -not $script:proc.HasExited) { try { Stop-Process -Id $script:proc.Id -Force } catch {} }
  # headless child processes for this profile
  Start-Sleep -Milliseconds 500
}

Export-ModuleMember -Function Start-CdpBrowser, Invoke-Cdp, Invoke-Js, Wait-Js, Open-CdpUrl, Save-CdpScreenshot, Save-CdpPdf, Stop-CdpBrowser, Get-BrowserPath
