# Sync design — and what we changed from EdgeHost

The local backend follows EdgeHost's proven shape (Go host → bundled Laravel
→ cloud) but rebuilds the sync engine. EdgeHost's mechanism was studied in
detail first; the changes below are the ones that mattered.

## Kept from EdgeHost

- Go host owns the lifecycle and binds the backend to loopback.
- Laravel as a pure JSON API with a local SQLite database (WAL, busy timeout).
- Staging-then-swap for replacements — EdgeHost did this correctly in exactly
  one place (`ModerationMirrorService`); we made it the rule, not the exception.
- Conditional requests for media — EdgeHost's avatar mirror did this well;
  we extended the idea to data as well.
- Content-addressed media filenames with atomic rename (also from the avatar
  mirror).

## Changed, and why

**1. One entity manifest instead of three.**
EdgeHost hardcoded its entity list in a React constant, a Go slice and a PHP
array. They drifted, so "update everything" meant different things depending
on which path triggered it. Ours lives in `config/nplcloud.php` and is served
at `/api/v1/sync/manifest` for the host and both UIs to read.

**2. Staging + verified swap for every entity.**
EdgeHost wiped live tables inside one transaction spanning *all* entities, so
the operational UI blocked (or read half-state) for the whole pull. We stage
per entity, verify the staged row count, then swap in a short transaction.

**3. An empty payload can no longer wipe live data.**
EdgeHost guarded only `players` ("0 rows aborts"); a truncated response for
any other entity silently emptied the local table. We refuse any empty
snapshot when live rows exist, unless `force` is passed.

**4. Per-entity resume state.**
EdgeHost kept one shared cursor on the host row, so a partial failure could
advance the watermark past an entity that never synced. Each entity now owns
its status, ETag, row count and last error in `sync_entity_states`.

**5. Conditional GETs on data, not just media.**
EdgeHost re-downloaded every row of every full-replace entity on every manual
update. We send `If-None-Match`; a `304` costs one round trip and skips the
entity entirely.

**6. 202 + poll instead of an unbounded request.**
EdgeHost posted the run with `timeout: 0` and polled alongside it; its settle
loop gave up after ~6 minutes and the client never learned the outcome. We
return the run id immediately and the UI polls one endpoint.

**7. Derived progress.**
EdgeHost's percentages were hardcoded constants (5/12/52/78/95/100), so a big
pull sat at "12%" for minutes. Ours is computed from entities completed.

**8. One lock, not two.**
EdgeHost held both an flock file lock (per-PHP-process, useless across a
FastCGI pool) and a DB lock row, which could disagree. One TTL'd DB lock is
the single arbiter, and it self-heals after a crash.

**9. Typed failures.**
EdgeHost classified errors by substring-matching messages ("timed out"),
which breaks on any driver or locale change. `CloudException` carries a code.

**10. One HTTP client.**
EdgeHost accumulated four (CloudClient, the outbox's own builder, a Guzzle
pool, and one in Go), each re-resolving base URL, TLS and timeouts. All calls
here go through `CloudClient`.

**11. Safe retries.**
EdgeHost retried POSTs blindly three times with no idempotency key. We retry
only idempotent GETs on connection failure; writes carry an
`Idempotency-Key` header so a retry is explicit and safe.

**12. Media that actually updates, and gets swept.**
EdgeHost's ad mirror used `is_file() && !force`, so a changed image at the
same path was *never* re-fetched, while `force` re-fetched everything — no
middle ground. It also wrote with a suppressed `@file_put_contents` (a crash
left a truncated file that then counted as cached) and never deleted orphans.
Ours does conditional requests, atomic renames, and prunes unreferenced files.

**13. A real dead-letter state.**
EdgeHost's outbox retried forever with no attempt ceiling. Ours caps attempts
and moves exhausted entries to `dead` where they are visible.

## Still to do (next step)

The Go host does not yet call these endpoints — wiring the host and the two
UIs to the backend is the next piece of work. The manifest, run and snapshot
endpoints are the contract they will use.
