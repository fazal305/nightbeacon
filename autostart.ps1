# Makes Nightbeacon start by itself every time you log in to Windows (after
# switching the laptop on), by putting a shortcut to start.cmd in your
# Startup folder. Nothing needs admin rights.
#
#   powershell -ExecutionPolicy Bypass -File autostart.ps1          turn on
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove  turn off
param([switch]$Remove)
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'Nightbeacon.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link; Write-Host 'Autostart turned off.' } else { Write-Host 'Autostart was not on.' }
  exit 0
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $PSScriptRoot 'start.cmd'
$shortcut.Arguments = '-NoBrowser'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7  # minimized
$shortcut.Description = 'Start Nightbeacon'
$shortcut.Save()
Write-Host "Autostart turned on: $link"
Write-Host 'Nightbeacon will start a few seconds after you log in. To turn it off:'
Write-Host '  powershell -ExecutionPolicy Bypass -File autostart.ps1 -Remove'
