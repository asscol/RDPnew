# Build script for the Windows host installer.
# Run from a Developer PowerShell on Windows.
#
#   .\packaging\windows\build.ps1
#
# Produces:  packaging\windows\RemoteDeskHost-Setup-<version>.exe

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$hostDir  = Join-Path $repoRoot "host"
$pkgDir   = Join-Path $repoRoot "packaging\windows"

Write-Host "==> Setting up Python venv"
Push-Location $hostDir
if (-not (Test-Path ".venv")) {
    python -m venv .venv
}
& .\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -e ".[dev]"

Write-Host "==> Running PyInstaller"
pyinstaller --noconfirm remotedesk-host.spec
if (-not (Test-Path "dist\remotedesk-host.exe")) {
    throw "PyInstaller did not produce dist\remotedesk-host.exe"
}

Pop-Location

Write-Host "==> Locating makensis"
$makensis = (Get-Command makensis -ErrorAction SilentlyContinue)?.Source
if (-not $makensis) {
    $candidate = "C:\Program Files (x86)\NSIS\makensis.exe"
    if (Test-Path $candidate) { $makensis = $candidate }
}
if (-not $makensis) {
    throw "makensis not found. Install NSIS (https://nsis.sourceforge.io/) or `choco install nsis`."
}

Write-Host "==> Running NSIS"
Push-Location $pkgDir
& $makensis "installer.nsi"
Pop-Location

Write-Host "Done. Installer: $pkgDir\RemoteDeskHost-Setup-*.exe"
