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
    Write-Host '== Creating venv =='
    # Prefer a SIGNED python.org install if one exists: Windows Application Control policies
    # can block uv-managed (python-build-standalone) interpreters' DLLs (_ctypes) outright —
    # seen on DESKTOP-NY 2026-08-25. Signed CPython passes; uv's build is the fallback.
    # Version-aware pick: numeric sort so Python313 beats Python39; skips 32-bit "-32" dirs;
    # floors at 3.12 (the old pin) so an ancient signed install never silently downgrades us.
    $signed = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue |
        ForEach-Object { if ($_.Directory.Name -match '^Python3(\d+)$') {
            [pscustomobject]@{ Exe = $_.FullName; Minor = [int]$Matches[1] } } } |
        Where-Object { $_.Minor -ge 12 } |
        Sort-Object Minor -Descending | Select-Object -First 1
    if ($signed) {
        Write-Host "Using signed system Python: $($signed.Exe)"
        uv venv $venv --python $signed.Exe
    } else {
        # uv occasionally errors linking a fresh interpreter download; a second attempt succeeds.
        try { uv python install 3.12 } catch { Write-Host 'retrying python install...'; try { uv python install 3.12 } catch {} }
        uv venv $venv --python 3.12
    }
} else { Write-Host "venv: OK ($venv)" }

# Application Control probe: a blocked interpreter fails right here, before the ~1.3 GB wheel
# install (the smoke test would also catch it via faster_whisper, but only after the download).
# No stderr redirect: under EAP=Stop, PS 5.1 turns redirected native stderr into a terminating
# NativeCommandError, which would mask the message below — let the traceback print instead.
if (-not (Test-Path $py)) { throw "venv creation failed - $py not found; see uv output above." }
$probe = & $py -c "import ctypes; print('ctypes-ok')"
if ($LASTEXITCODE -ne 0 -or "$probe" -notmatch 'ctypes-ok') {
    throw @'
The venv Python cannot load _ctypes - a Windows Application Control policy is likely blocking
this interpreter's DLLs. Install signed Python from python.org (winget install Python.Python.3.13),
delete ~\.session-scribe\venv, and re-run this script; it will pick up the signed install.
'@
}

$staleBackups = Get-ChildItem "$home_\.session-scribe" -Directory -Filter 'venv-blocked-*' -ErrorAction SilentlyContinue
if ($staleBackups) {
    Write-Host "note: stale blocked-venv backup(s), ~1.3 GB each, safe to delete once this run passes:"
    $staleBackups | ForEach-Object { Write-Host "      $($_.FullName)" }
}

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
if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed - see output above.' }

if ($PrefetchModel) {
    Write-Host '== Prefetching large-v3-turbo (~1.6 GB) =='
    & $py -c "from faster_whisper import download_model; download_model('large-v3-turbo'); print('model cached')"
}

Write-Host ''
Write-Host 'session-scribe toolchain READY.'
