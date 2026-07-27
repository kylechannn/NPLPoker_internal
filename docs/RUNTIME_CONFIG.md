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
