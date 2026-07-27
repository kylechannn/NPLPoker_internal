# NPL Poker Internal

Native Windows operational system for NPL Poker internal operations. It follows the portable EdgeHost pattern:

- a Go executable owns the application lifecycle, API, and desktop window;
- a bundled Caddy process is the local gateway;
- a React/Vite application is compiled into the binary and displayed inside WebView2;
- the built bundle runs without requiring Caddy on the machine `PATH`.

The runtime defaults to an adaptive low-resource profile and does not require
PHP or a PHP-FPM worker pool. See `docs/RUNTIME_CONFIG.md` for the validated
resource profiles and optional overrides.

## Prerequisites

- Go 1.22 or newer
- Node.js 22 and npm
- the local EdgeHost reference bundle, used as the trusted source for Caddy

The interface opens as a native, resizable Windows application. Its local services use:

- Go backend: `127.0.0.1:8788`
- desktop-only Caddy gateway: [http://127.0.0.1:8787](http://127.0.0.1:8787)
- route-limited staff QR gateway: `http://<venue-lan-ip>:8790`

The staff gateway follows EdgeHost's single-ingress mobile pattern, but exposes
only `/staff-login` and the mobile session check. The operational SPA, license
APIs, health APIs, and scoring data cannot be requested through the LAN
listener.

Each QR request uses a cryptographically random one-time token, a separate
six-digit pairing code, a three-minute expiry, a five-attempt limit, and an
eight-hour HttpOnly phone session. Approved staff identity is reflected in the
desktop operator card.

## Setup and build

```powershell
.\scripts\setup.ps1
.\scripts\build.ps1
.\scripts\start.ps1
```

`setup.ps1` verifies Go/Node/npm, copies the Caddy executable from the local EdgeHost bundle into `.tools`, and installs dependencies. `build.ps1` compiles React, runs Go tests, builds the Windows executable, validates the Caddy configuration, and creates the portable `dist` bundle.

Double-click `dist\NPLPokerInternal.exe` or run `scripts\start.ps1`; the desktop window opens automatically.

To allow phones on the local subnet through Windows Firewall, run the generated
helper once from an elevated PowerShell session:

```powershell
.\dist\ConfigureStaffGateway.ps1 -CaddyPath .\dist\redist\caddy\caddy.exe
```

The rule is limited to TCP port `8790`, the bundled Caddy executable, and
`LocalSubnet` remote addresses. It does not expose the desktop gateway.

For headless service troubleshooting:

```powershell
.\dist\NPLPokerInternal.exe --headless
```

For direct Go-only troubleshooting without Caddy:

```powershell
.\dist\NPLPokerInternal.exe --headless --direct
```

## Project layout

```text
.
├── config.go          Validated runtime and resource profiles
├── main.go            Go host, API, embedded SPA, and Caddy lifecycle
├── Caddyfile          Private local reverse-proxy gateway
├── docs/              Runtime configuration reference
├── scripts/           Setup, build, and start commands
├── ui/                React/Vite source
└── dist/              Portable build output (generated)
```
