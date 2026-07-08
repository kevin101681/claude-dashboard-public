# Restarts the Claude Dashboard server. Meant to run inside a dashboard-owned
# PowerShell session (the Restart button), which is a child of the server and
# dies the moment the server does -- so the kill/start work runs DETACHED.
$cfg = Get-Content (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$port = if ($cfg.port) { [int]$cfg.port } else { 4310 }
$inner = "Start-Sleep -Seconds 1; " +
  "Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | " +
  "ForEach-Object { Stop-Process -Id `$_.OwningProcess -Force }; " +
  "Start-Sleep -Seconds 1; Start-ScheduledTask -TaskName 'Claude Dashboard'"
Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $inner
Write-Host ''
Write-Host 'Restart scheduled. The dashboard drops for a few seconds, then comes back.'
Write-Host 'This session will disconnect - go Back and reload if it does not recover.'
