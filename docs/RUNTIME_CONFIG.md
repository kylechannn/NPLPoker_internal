# Runtime configuration

NPL Poker Operational System uses a local Go host, a private Caddy gateway,
and Microsoft Edge WebView2. It does not use PHP, PHP-CGI, PHP-FPM, or a PHP
worker pool.

## Resource profiles

`NPL_RESOURCE_PROFILE` selects a validated runtime profile:

| Profile | Go workers | Go memory | Caddy workers | Caddy memory | Network sample cache |
| --- | ---: | ---: | ---: | ---: | ---: |
| `adaptive` (default) | 1–4 based on CPU | 192 MiB | 1–2 based on CPU | 96 MiB | 30 seconds |
| `low` | 1–2 based on CPU | 128 MiB | 1 | 64 MiB | 45 seconds |
| `balanced` | 1–4 based on CPU | 256 MiB | 1–2 based on CPU | 128 MiB | 20 seconds |

The default adaptive profile is suitable for weak laptops while retaining
enough concurrency for the local UI.

## Optional overrides

These environment variables override one profile value:

- `NPL_GO_MAX_PROCS`: `1`–`32`
- `NPL_GO_MEMORY_LIMIT_MIB`: `64`–`2048`
- `NPL_CADDY_MAX_PROCS`: `1`–`16`
- `NPL_CADDY_MEMORY_LIMIT_MIB`: `64`–`1024`
- `NPL_NETWORK_CACHE_SECONDS`: `15`–`300`

The local endpoints remain configurable with `NPL_INTERNAL_BACKEND` and
`NPL_INTERNAL_LISTEN`, but both are validated as loopback-only addresses.
`NPL_CADDY_EXE` can point to a specific Caddy executable.

Invalid values stop startup with a clear native error instead of silently
running an unsafe or resource-heavy configuration.

## Staff QR gateway

The Caddy configuration has two deliberately separate listeners:

- `NPL_INTERNAL_LISTEN` defaults to `127.0.0.1:8787` and carries the complete
  desktop application.
- `NPL_STAFF_LISTEN` defaults to `0.0.0.0:8790` and carries only
  `/staff-login`, `/staff-login/approve`, and `/api/staff-login/session`.

Caddy overwrites `X-NPL-Gateway` at each trust boundary. Go then rejects staff
routes arriving through the desktop boundary and rejects desktop challenge
control arriving through the staff boundary. Caller-supplied gateway headers
are never trusted.

NPL OS selects the active default-route IPv4 address for each QR. Set
`NPL_STAFF_PUBLIC_URL` to a clean HTTP or HTTPS origin when the venue requires
an explicit address, for example:

```powershell
$env:NPL_STAFF_PUBLIC_URL = "http://192.168.20.15:8790"
```

`NPL_STAFF_LISTEN` accepts wildcard, loopback, or private LAN addresses only.
Public bind addresses are rejected at startup. The Windows Firewall helper
generated into `dist` permits only the selected Caddy executable, TCP port
`8790`, and remote clients in `LocalSubnet`.
