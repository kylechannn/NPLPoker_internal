# NPL Poker Internal — local backend

The bundled Laravel application that runs on the venue machine. It mirrors
NPL cloud data into local SQLite so the operational system keeps working when
the venue's internet does not, and pushes local changes back through an
outbox.

Structured like `NPLPoker_backend` (same Laravel idioms, service classes,
`routes/api.php`) so a change made there is easy to mirror here.

## Local API

The Go host binds this to loopback; nothing is LAN-reachable.

| Route | Purpose |
|---|---|
| `GET /api/health` | Liveness for the host's readiness probe |
| `GET /api/v1/sync/manifest` | **Shared source of truth** — the entity list plus each entity's status, row count and last error |
| `POST /api/v1/sync/run` | Start a manual update. Returns **202** with a run id |
| `GET /api/v1/sync/runs/{uuid}` | Poll one run |
| `GET /api/v1/sync/runs/latest` | Poll the most recent run |
| `GET /api/v1/sync/snapshot` | The mirrored data the operational UI renders |
| `GET /api/media/{key}` | A cached image, served locally |

CLI equivalent: `php artisan sync:pull`.

## What a manual update pulls

| Entity | Mode | Why the venue needs it |
|---|---|---|
| `venues` | snapshot | Venue details |
| `game_sessions` | snapshot | Today's sessions |
| `game_entities` | **delta** | The templates the venue hosts games from |
| `players` | **delta** | Member list + avatars installed locally |
| `player_relationships` | **delta** | Friend/block lists — staff must not seat two players who blocked each other |
| `seating` | snapshot | Tables and seats per session |

**Snapshot** entities are small, so they are replaced wholesale (staging +
verified swap). **Delta** entities are the big, slow-changing ones: only rows
changed since the local watermark are fetched, paged with a keyset cursor,
and upserted in place. Deletions reconcile against a cheap id-only endpoint.
An unchanged entity costs a single `304`.

After every run the install reports its own state back (`last_pull_at`,
`last_push_at`, row counts) so support can see the machine from the admin
License tab.

## How a manual update works

1. Acquire one TTL'd DB lock (`sync_locks`) — a crashed run self-heals.
2. Walk `config/nplcloud.php` entities in dependency order.
3. Per entity: conditional `GET` with the stored ETag. A `304` skips it.
4. Rows land in `<table>_staging`, the count is verified, then a **short**
   transaction swaps staging into the live table.
5. Install player avatars and link each one to its player row — that local
   key is what the UI resolves through `/api/media/{key}`, never the cloud.
6. Cache every other referenced image, content-addressed and atomically renamed.
7. Sweep media no row references any more.
8. Heartbeat the install's state back to the cloud.

An entity that fails degrades the run to `partial` and records its own error
in `sync_entity_states`; the others still apply.

## Guard rails

- An empty cloud payload never replaces a populated local table — it is
  treated as a truncated response (override with `force`).
- Staged row counts are verified before the swap.
- Media is written to `.part` then renamed, so a crash cannot leave a
  truncated file that later counts as cached.
- Outbox entries carry an idempotency key, are attempt-capped, and land in
  `dead` rather than retrying forever.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NPL_CLOUD_BASE` | `https://api.nplpokerclub.com.au` | Cloud API root |
| `NPL_INTERNAL_DATA_DIR` | OS config dir | Where `license.json` lives |
| `NPL_MEDIA_PATH` | `storage/app/media` | Image cache root |
| `NPL_CLOUD_TIMEOUT` | `30` | Request timeout (seconds) |
| `NPL_OUTBOX_MAX_ATTEMPTS` | `12` | Before an entry is dead-lettered |

The CD-Key is **not** configured here: the Go host owns activation and writes
`license.json`, which this app reads for the `X-CD-Key` / `X-Device-Id`
headers.

## Tests

```bash
php artisan test
```
