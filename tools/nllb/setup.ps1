# One-time setup of the local NLLB-200 translator (Meta's model, free and
# unlimited, runs on this computer). Needs Python 3.11 (same as LibreTranslate)
# and about 5 GB free disk during setup (about 1 GB afterwards).
#
#   powershell -ExecutionPolicy Bypass -File tools\nllb\setup.ps1
#
# Then start.cmd starts it automatically, and NLLB_URL is set in server\.env.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$venv = Join-Path $here 'venv'
$model = Join-Path $here 'model'
$py = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $py)) {
  Write-Host 'Creating Python environment...'
  py -3.11 -m venv $venv
}
Write-Host 'Installing packages (a few minutes)...'
& $py -m pip install --upgrade pip
& $py -m pip install ctranslate2 sentencepiece transformers
# torch is only needed once, to convert the model.
& $py -m pip install torch --index-url https://download.pytorch.org/whl/cpu

if (-not (Test-Path (Join-Path $model 'model.bin'))) {
  Write-Host 'Downloading and converting NLLB-200 (about 2.5 GB download, 10-20 minutes)...'
  & (Join-Path $venv 'Scripts\ct2-transformers-converter.exe') `
    --model facebook/nllb-200-distilled-600M --output_dir $model --quantization int8 `
    --copy_files tokenizer.json tokenizer_config.json special_tokens_map.json sentencepiece.bpe.model
}

Write-Host 'Removing torch (no longer needed)...'
& $py -m pip uninstall -y torch

$envFile = Join-Path $here '..\..\server\.env'
if (Test-Path $envFile) {
  if (Select-String -Path $envFile -Pattern '^NLLB_URL=' -Quiet) {
    (Get-Content $envFile) -replace '^NLLB_URL=.*', 'NLLB_URL=http://127.0.0.1:6060' | Set-Content $envFile
  } else {
    Add-Content $envFile 'NLLB_URL=http://127.0.0.1:6060'
  }
}
Write-Host 'NLLB is ready. It starts with start.cmd; add "nllb" to TRANSLATION_PROVIDER in server\.env.'
