# session-scribe machine bootstrap — idempotent; safe to re-run.
# Installs ffmpeg + uv (winget), builds the ~\.session-scribe venv (Python 3.12,
# faster-whisper + NVIDIA CUDA wheels), generates a TTS test clip, runs the smoke test.
# Usage:  powershell -ExecutionPolicy Bypass -File setup.ps1 [-PrefetchModel]

param([switch]$PrefetchModel)

$ErrorActionPreference = 'Stop'

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path', 'User')
}

Refresh-Path

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host '== Installing ffmpeg (winget) =='
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
} else { Write-Host 'ffmpeg: OK' }

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host '== Installing uv (winget) =='
    winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
} else { Write-Host 'uv: OK' }

$home_ = $env:USERPROFILE
$venv = "$home_\.session-scribe\venv"
$py = "$venv\Scripts\python.exe"

if (-not (Test-Path $py)) {
    Write-Host '== Creating venv (Python 3.12) =='
    # uv occasionally errors linking a fresh interpreter download; a second attempt succeeds.
    try { uv python install 3.12 } catch { Write-Host 'retrying python install...'; try { uv python install 3.12 } catch {} }
    uv venv $venv --python 3.12
} else { Write-Host "venv: OK ($venv)" }

Write-Host '== Installing faster-whisper + CUDA wheels (idempotent; ~1.3 GB first time) =='
uv pip install --python $py faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12

$clip = "$home_\.session-scribe\test_speech.wav"
if (-not (Test-Path $clip)) {
    Write-Host '== Generating TTS test clip =='
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SetOutputToWaveFile($clip)
    $s.Speak('The party enters the warehouse. Roll for initiative. The goblin attacks with a rusty dagger.')
    $s.Dispose()
}

Write-Host '== Smoke test (loads tiny model; verifies CUDA stack) =='
& $py "$PSScriptRoot\session_scribe.py" smoke $clip
if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed — see output above.' }

if ($PrefetchModel) {
    Write-Host '== Prefetching large-v3-turbo (~1.6 GB) =='
    & $py -c "from faster_whisper import download_model; download_model('large-v3-turbo'); print('model cached')"
}

Write-Host ''
Write-Host 'session-scribe toolchain READY.'
