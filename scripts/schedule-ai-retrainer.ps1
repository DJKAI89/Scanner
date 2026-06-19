$ErrorActionPreference = "Stop"

param(
  [string]$TaskName = "FridayAiRetrainer",
  [string]$WorkDir = "E:\Dhaval\Scanner",
  [string]$NodeExe = "node",
  [string]$RunAt = "18:10"
)

$scriptPath = Join-Path $WorkDir "scripts\train-ai-model.mjs"
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$scriptPath`"" -WorkingDirectory $WorkDir
$trigger = New-ScheduledTaskTrigger -Daily -At $RunAt
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Scheduled task '$TaskName' created for $RunAt"
