$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "FridayAiRetrainer",
  [string]$WorkDir = "E:\Dhaval\Scanner",
  [string]$NodeExe = "node",
  [string]$RunAt = "18:10",
  [string]$LogFile = "$WorkDir\logs\ai-retrainer.log"
)

# Ensure log directory exists
$LogDir = Split-Path -Parent $LogFile
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
  Write-Host "Created log directory: $LogDir"
}

# Create a wrapper script that logs both stdout and stderr
$WrapperScript = Join-Path $WorkDir "scripts\run-ai-retrainer.ps1"
$WrapperContent = @"
param([string]`$NodeExe, [string]`$ScriptPath, [string]`$LogFile)
`$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
"`$timestamp [START] AI Retrainer starting..." | Out-File -Append -Path `$LogFile -Encoding UTF8

try {
  & `$NodeExe "`$ScriptPath" 2>&1 | Tee-Object -Append -FilePath `$LogFile
  `$exitCode = `$LASTEXITCODE
  if (`$exitCode -eq 0) {
    Get-Date -Format "yyyy-MM-dd HH:mm:ss" | ForEach-Object { "`$_ [SUCCESS] AI Retrainer completed successfully" } | Out-File -Append -Path `$LogFile -Encoding UTF8
  } else {
    Get-Date -Format "yyyy-MM-dd HH:mm:ss" | ForEach-Object { "`$_ [ERROR] AI Retrainer exited with code `$exitCode" } | Out-File -Append -Path `$LogFile -Encoding UTF8
  }
  exit `$exitCode
} catch {
  Get-Date -Format "yyyy-MM-dd HH:mm:ss" | ForEach-Object { "`$_ [ERROR] Exception: `$(`$_.Exception.Message)" } | Out-File -Append -Path `$LogFile -Encoding UTF8
  exit 1
}
"@

if (-not (Test-Path $WrapperScript)) {
  $WrapperContent | Out-File -Path $WrapperScript -Encoding UTF8
  Write-Host "Created wrapper script: $WrapperScript"
}

$scriptPath = Join-Path $WorkDir "scripts\train-ai-model.mjs"
$psArgs = @(
  "-NoProfile"
  "-ExecutionPolicy", "Bypass"
  "-File", $WrapperScript
  "-NodeExe", $NodeExe
  "-ScriptPath", $scriptPath
  "-LogFile", $LogFile
)

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $psArgs -WorkingDirectory $WorkDir
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RunOnlyIfNetworkAvailable

# Register the task with error handling
try {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "✅ Scheduled task '$TaskName' created successfully"
  Write-Host "   Runs daily at: $RunAt"
  Write-Host "   Working directory: $WorkDir"
  Write-Host "   Log file: $LogFile"
  Write-Host ""
  Write-Host "💡 To manually trigger the task:"
  Write-Host "   Start-ScheduledTask -TaskName '$TaskName'"
  Write-Host ""
  Write-Host "💡 To view logs:"
  Write-Host "   Get-Content '$LogFile' -Tail 50 -Wait"
} catch {
  Write-Host "❌ Failed to create scheduled task: $($_.Exception.Message)"
  exit 1

}
