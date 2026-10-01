# NPL Poker OS — Modern Installer

The NPL Poker take on the Mahjong Scoring modern installer: an Electron
front-end (65% navy hero / 35% white control panel, NPL badge, cyan
accents) wrapping the SAME `installer\NPLPokerOS.iss` engine that the
classic setup uses. Electron only replaces the experience layer — Inno
Setup still owns the real install, upgrade preservation (`.env`,
`database.sqlite`, `storage\`), and the payload verification.

## Build

Requires Windows, Node 20+, Inno Setup 6, and an assembled
`installer\payload\` (run `installer\build-installer.ps1` first, or
`-SkipBuild` with a fresh `dist\`).

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1 -Version 2.0.0
```

Output: `release\NPLPokerOS-InstallOrUpdate-<version>-Modern.exe`
(+ `.sha256`). A portable Electron exe with the compiled engine inside;
`compression: store` so the splash (`build\splash.bmp`) appears fast.

Preview the UI without installing:

```powershell
$env:INSTALLER_PREVIEW = "1"; npm start
```

## How it runs

1. Electron shows the navy brand screen; the user clicks **Install now**.
2. The embedded engine runs `/VERYSILENT` with `/STATUSFILE=<tmp>`.
3. The `[Code]` status bridge in `NPLPokerOS.iss` writes
   `{state, progress, message}` JSON; Electron polls it every 250 ms.
4. A non-zero exit or a `failed` state shows the retry + logs screen.
5. On completion the primary button becomes **Launch NPL Poker OS**.

## Version bumps

Change together: `package.json` and `package-lock.json` root versions,
the build scripts' default versions, `NPLPokerOS.iss`, and the version
text in `electron/renderer/index.html` and `renderer.js`. Update all
versions in `winres/winres.json` and regenerate the committed Windows
resource with `go-winres make --in winres/winres.json --arch amd64`.

Run the complete `installer/build-installer.ps1 -Version 2.0.0` product
build before this Electron build so the embedded OS runtime and installer
share the release version. Verify the host executable's Windows file
version as well as the runtime version passed through Go's linker flags.
