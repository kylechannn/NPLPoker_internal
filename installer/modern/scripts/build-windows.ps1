param(
  [string]$Version = "1.1.0",
  [string]$InnoSetupCompiler = ""
)

$ErrorActionPreference = "Stop"

# electron-builder shells out to powershell.exe while packaging; robocopy and
# friends live in System32. A trimmed PATH (common when launched from WSL)
# breaks both, so make sure the system directories are present.
foreach ($SystemDir in @(
  (Join-Path $env:SystemRoot "System32"),
  (Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0")
)) {
  if ($env:PATH -notlike "*$SystemDir*") {
    $env:PATH = "$env:PATH;$SystemDir"
  }
}

$Root = Split-Path -Parent $PSScriptRoot          # installer\modern
$InstallerDir = Split-Path -Parent $Root          # installer
$InstallerScript = Join-Path $InstallerDir "NPLPokerOS.iss"
$ClassicPayload = Join-Path $InstallerDir "payload\NPLPokerOS.exe"
$Engine = Join-Path $Root "payload\NPLPokerOS-Engine.exe"

# The engine compiles from installer\payload — the tree build-installer.ps1
# assembles from dist\. Refusing here beats shipping a stale or empty engine.
if (-not (Test-Path $ClassicPayload)) {
  throw "installer\payload is not assembled. Run installer\build-installer.ps1 (or -SkipBuild with a fresh dist\) first."
}

if (-not (Test-Path (Join-Path $Root "build\splash.bmp"))) {
  throw "build\splash.bmp is missing. It is shown while the portable exe unpacks - restore it before building."
}

if (-not $InnoSetupCompiler) {
  $Candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  $InnoSetupCompiler = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

if (-not $InnoSetupCompiler -or -not (Test-Path $InnoSetupCompiler)) {
  throw "Inno Setup 6 compiler was not found. Install Inno Setup 6 or pass -InnoSetupCompiler with the full ISCC.exe path."
}

# A previous release must never be mistaken for the new one.
$ReleaseDir = Join-Path $Root "release"
if (Test-Path $ReleaseDir) {
  Remove-Item $ReleaseDir -Recurse -Force
}

Push-Location $Root
try {
  # The same NPLPokerOS.iss the classic installer uses, redirected into
  # modern\payload as the silent engine. The status bridge inside it only
  # wakes when the Electron shell passes /STATUSFILE=.
  & $InnoSetupCompiler "/DMyAppVersion=$Version" "/O$(Join-Path $Root 'payload')" "/FNPLPokerOS-Engine" $InstallerScript
  if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
  }

  if (-not (Test-Path $Engine)) {
    throw "Inno Setup completed without creating $Engine"
  }

  # Guard against packaging while ISCC (or anything else) is still writing
  # the engine: the size must be stable across a short wait.
  $SizeBefore = (Get-Item $Engine).Length
  Start-Sleep -Seconds 3
  $SizeAfter = (Get-Item $Engine).Length
  if ($SizeBefore -ne $SizeAfter) {
    throw "payload\NPLPokerOS-Engine.exe is still being written ($SizeBefore -> $SizeAfter bytes). Wait for the compile to finish, then rerun."
  }

  if (Test-Path (Join-Path $Root "package-lock.json")) {
    npm ci
  }
  else {
    npm install
  }

  if ($LASTEXITCODE -ne 0) {
    throw "npm dependency installation failed with exit code $LASTEXITCODE."
  }

  npm run dist
  if ($LASTEXITCODE -ne 0) {
    throw "Electron packaging failed with exit code $LASTEXITCODE."
  }
}
finally {
  Pop-Location
}

$Result = Join-Path $Root "release\NPLPokerOS-InstallOrUpdate-$Version-Modern.exe"
if (-not (Test-Path $Result)) {
  throw "The expected installer was not created at $Result (does package.json's version match -Version?)"
}

# The packaged engine must be byte-identical to the one just compiled — a
# mismatch means the build raced another process.
$PackagedEngine = Join-Path $Root "release\win-unpacked\resources\payload\NPLPokerOS-Engine.exe"
if (-not (Test-Path $PackagedEngine)) {
  throw "The packaged engine is missing at $PackagedEngine"
}
$SourceHash = (Get-FileHash $Engine -Algorithm SHA256).Hash
$PackedHash = (Get-FileHash $PackagedEngine -Algorithm SHA256).Hash
if ($SourceHash -ne $PackedHash) {
  throw "Packaged engine does not match payload\NPLPokerOS-Engine.exe. The build raced another process - rerun with nothing else touching the folder."
}

# Emit a checksum so a copy on another laptop can be verified with:
#   certutil -hashfile NPLPokerOS-InstallOrUpdate-<version>-Modern.exe SHA256
$ResultHash = (Get-FileHash $Result -Algorithm SHA256).Hash
$ResultSize = (Get-Item $Result).Length
Set-Content -Path "$Result.sha256" -Value "$ResultHash  $(Split-Path -Leaf $Result)"

Write-Host "Modern installer created: $Result"
Write-Host ("Size   : {0:N1} MB" -f ($ResultSize / 1MB))
Write-Host "SHA256 : $ResultHash"
Write-Host "After copying to another laptop, verify with: certutil -hashfile <file> SHA256"
