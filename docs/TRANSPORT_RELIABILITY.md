# Phase 1: reliable desk updates

The desk receives invalidation signals and reads authoritative data over HTTP. A
WebSocket frame is neither a database snapshot nor an acknowledgement of a sale
or physical Cash move. Existing event/channel names remain compatible with the
cloud and mobile clients.

## Receive and reconcile

`useBackendLink` uses one Pusher-protocol connection for the active venue plus the
jackpot channel. It becomes connected only after that exact venue subscription
is confirmed. Connection-details fetch and venue subscription have 15-second
deadlines; close/error uses the existing 2–30 second reconnect backoff. Stale
socket callbacks cannot update a replacement connection.

`session.touched` emits a scoped `npl:session-touched` event immediately. The
current HostDesk starts Cash move/service reconciliation without waiting for its
timers. The gateway also pulls the session/seating mirror; only a successful pull
emits `npl:sessions-updated` with `{venueId, sessionIds}`. That event refreshes the
matching HostDesk immediately. Session IDs in these events are **cloud** IDs;
HostDesk HTTP paths use the **local** tournament ID. Unknown/malformed targets
perform a full catch-up for the current venue. The existing wheel approval and
jackpot events retain their exact request/pool payloads.

Reconciliation is single-flight, with one trailing pass when signals arrive
during a request. Failed mirror pulls retain their target IDs and retry after
five seconds even if the socket remains connected and sends no more events.
Venue changes clear obsolete targets/retries; a previous venue's response cannot
publish an update to the newly selected workspace. Focus, online, visibility
return and successful subscription also request catch-up. Existing fallback
intervals remain: HostDesk seating/Cash commands 5 seconds, service 15 seconds,
gateway disconnected mirror pull 60 seconds and healthy-link reconciliation
5 minutes. These are scheduling intervals, not network delivery guarantees.

HostDesk request owners are fenced by local session and component lifecycle.
Delayed responses after switching desks or unmounting cannot replace seating,
service state or notices. Poll snapshots begun before a direct seating mutation
are discarded. Repeated events/timers share a runner instead of launching
overlapping calls. Local API calls must return a successful `{ok:true,data}`
envelope; a 2xx HTML/error response does not mean the operation completed.

Seat mirror reads preserve the last known data on licence refusal, malformed
responses, rate limits and transport/server failures. Only explicit HTTP 404/410
allows a disappeared session's mirror to be cleared.

## Send, retry and acknowledgement

The existing `sync_outbox`, `cloud_call_queue`, FIFO ordering, retry budgets,
offline pause/probe and operator-visible dead letters remain in use. New generic
queue jobs get a persisted idempotency key when enqueued. A legacy keyless job
gets one **before** its first attempt under this release; every later retry uses
that same key, including DELETE. A new coalesced clock payload gets a new key;
an in-flight payload cannot be overwritten. The drainer reads the claimed
revision so it cannot send an obsolete payload and mark a newer one delivered.
Cloud endpoints must honour their idempotency contract; the OS does not infer
successful remote execution from a disconnected request.

Cash moves retain their physical-seat journal and original ledger rules. Local
application records `applied_pending` or `failed_pending`; the retry uses the
same `cash-move:{id}:{status}` key and `cash-move:{id}` reference. A journal is
completed only when the response explicitly names the same move, returns
`applied` or `failed`, supplies a nonnegative version, and matches the local
reference when supplied. Empty, mismatched or pending acknowledgements remain
pending. Retrying does not buy in, charge, print or move twice. A confirmed cloud
failure still uses the existing rollback/recovery behavior.

Cash feed/application/ACK checks a fresh opaque licence+device identity and the
local-to-cloud session link around network awaits. A licence replacement,
session relink or finished/cancelled session stops old work; it cannot complete
an old journal against a different desk. Lease renewal alone is not a new
identity. No credentials or identity fingerprint are logged or sent to the UI.
Historical generic queues do not contain original licence provenance; this
release does not guess it, migrate operations between licences, or erase them.
Their existing cloud licence/session authorization still applies.

## Verification

- `cd ui && npm run test:transport`: coalescing, lifecycle/venue fencing,
  retained targets, automatic retry, scope filtering and full catch-up.
- `cd ui && npm run build`: TypeScript and production Vite build.
- Bundled Laravel: `php artisan test`; focused cases include
  `CashTableMoveTest`, `QueueEverywhereTest`, `TransportRecoveryTest`,
  `TableServicePullerTest` and `CloudLinkPauseTest`.
- Real HostDesk and gateway were exercised in headless Edge with mocked local
  HTTP/WebSocket: immediate relevant-session updates, irrelevant-session filter,
  no concurrent Cash pull, stale session/venue rejection, malformed-frame
  catch-up and unchanged exact wheel approval forwarding.

Production validation still needs a licensed desk and real cloud broadcaster:
register on a phone and observe OS/other clients; disconnect/reconnect the desk;
accept a Cash transfer while dropping its ACK response and confirm one physical
move with no duplicate charge; verify the preserved pending journal recovers.
This phase does not change full-list/delta APIs, transport payload size, gameplay
rules or the five/fifteen-second operational fallbacks.
