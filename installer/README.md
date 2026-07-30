# NPL Poker OS installer

Production Inno Setup installer for the whole system: Go host, embedded UI,
bundled Laravel backend (with `vendor\`), portable PHP, Caddy, a fresh `.env`
with a generated `APP_KEY`, and a pre-migrated `database.sqlite`.

## Prerequisites

- Everything `scripts\build.ps1` already needs (Node, Go, the EdgeHost
  reference bundle at `C:\Users\kylec\dist\EdgeHost_bundle` for portable PHP).
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) — `ISCC.exe` is probed at
  the standard install paths.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -Version 1.0.0
```

Output: `installer\output\NPLPokerOS-Setup-<version>.exe` plus a `.sha256`
file. Add `-SkipBuild` to reuse the existing `dist\` when only iterating on
the installer itself.

## What upgrades preserve

Re-running a newer installer over an existing install refreshes all program
files but never touches venue data: `app\npl_internal\.env`,
`app\npl_internal\database\database.sqlite`, and everything under
`app\npl_internal\storage\` are installed only if absent and are never
removed by the uninstaller (nor are `logs\`). The licence lives in
`%APPDATA%\NPLPokerInternal\license.json`, outside the install directory.

## Verify on the target laptop

Before running the copied installer:

```
certutil -hashfile NPLPokerOS-Setup-<version>.exe SHA256
```

The hash must match the one the build printed (also in the `.sha256` file).
A mismatch means the copy was truncated in transfer — re-copy it. The
installer additionally verifies the critical payload files on disk after
install and aborts with a message if any are missing.

## First run

- Requires the WebView2 runtime (preinstalled on current Windows 10/11).
- The app starts unlicensed: activate with a CD-Key, then pick the venue.
  Venue data arrives via licence activation and Manual update — every
  install starts from a clean, freshly migrated database.
- Windows Firewall will prompt for the staff gateway on first launch;
  `ConfigureStaffGateway.ps1` in the install directory can set the rules up.
