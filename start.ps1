# Starts everything Nightbeacon needs, each in its own window:
#   LibreTranslate (if installed in C:\coding\libretranslate), the server
#   (which also starts the local PostgreSQL), and the web app; then opens the
#   dashboard. Double-click start.cmd, or run:  powershell -ExecutionPolicy Bypass -File start.ps1
$root = $PSScriptRoot
$libre = if ($env:LIBRETRANSLATE_DIR) { $env:LIBRETRANSLATE_DIR } else { 'C:\coding\libretranslate' }
$libreExe = Join-Path $libre 'Scripts\libretranslate.exe'
$libreLangs = if ($env:LIBRETRANSLATE_LANGS) { $env:LIBRETRANSLATE_LANGS } else { 'en,ar,fa,ru,he,uk,tr,ur' }

function Start-Window($title, $dir, $command) {
  $script = "`$Host.UI.RawUI.WindowTitle = '$title'; Set-Location '$dir'; $command"
  Start-Process powershell -ArgumentList '-NoExit', '-NoProfile', '-Command', $script -WindowStyle Minimized
}

if (Test-Path $libreExe) {
  Write-Host 'Starting LibreTranslate...'
  Start-Window 'Nightbeacon - LibreTranslate' $libre "& '$libreExe' --host 127.0.0.1 --port 5000 --load-only $libreLangs"
} else {
  Write-Host "LibreTranslate not found at $libreExe - skipping (optional)."
}

Write-Host 'Starting server (it also starts PostgreSQL)...'
Start-Window 'Nightbeacon - server' (Join-Path $root 'server') 'npm run dev'

Write-Host 'Starting web app...'
Start-Window 'Nightbeacon - web' (Join-Path $root 'web') 'npm run dev'

Start-Sleep -Seconds 8
Start-Process 'http://localhost:5173'
Write-Host 'Done. The three windows are minimized in the taskbar; close them to stop Nightbeacon.'
