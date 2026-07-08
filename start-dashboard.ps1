# Starts the Claude Dashboard server (hidden window friendly).
# For auto-start on login, register with Task Scheduler:
#   schtasks /create /tn "Claude Dashboard" /sc onlogon /rl limited `
#     /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File '$PSScriptRoot\start-dashboard.ps1'"
Set-Location $PSScriptRoot
node server.js
