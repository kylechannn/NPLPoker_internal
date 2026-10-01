# Reliable and efficient desk updates

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

`session.touched` emits a scoped `npl:session-touched` event before mirror HTTP. The
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
The five/fifteen-second operational fallbacks and gameplay rules remain unchanged.

## Phase 2: batching and conditional reads

Session signals share a fixed 120 ms batching window. Repeated durable `event_id`
values are ignored within the current socket (bounded to the last 256 IDs).
Different sessions are grouped into batches of at most 20; larger bursts drain
additional targeted batches rather than becoming an unrelated venue-wide pull.
This is a fixed window, so ongoing traffic cannot postpone a refresh indefinitely.
Failed targets still retry after five seconds. Venue changes cancel scheduled
batches and fence old completions.

Each batch wakes Cash/service consumers once before fetching the mirror. Its
successful `npl:sessions-updated` event carries `commandsNotified: true`: HostDesk
refreshes its local seating but does not repeat the Cash/service requests already
started by that batch. Legacy/manual events without that flag still reconcile.
Reconnect, focus, visibility/online return and the existing healthy/disconnected
safety pulls remain. No polling interval was reduced or removed.

Targeted pulls use licensed `GET /api/v1/internal/sessions/snapshots?ids[]=...`.
One response contains each requested session's public-compatible metadata and
licensed seating, replacing the global metadata-list read plus one seating read
per target. All IDs and statuses are checked before any mirror write; a partial,
refused or malformed response retains the previous mirror and retries. Metadata
404 can remove old metadata while seating 200 preserves the staff seat map.
Only explicit seating 404 clears those seat rows. An endpoint-level 404 falls
back to the older global-list/individual-seating path for rolling deployment.
Other HTTP errors never trigger that fallback. Full venue reconciliation and
the established slow-entity delta/manual update paths remain available.

`ConditionalCloudRead` opts in with `X-NPL-Conditional: 1` and `If-None-Match` for
the batch, licensed seating, Cash move feed and combined desk pulse. Cached
representations are scoped by opaque licence/device identity, cloud base, exact
path/query and application language, and expire after one hour. A 304 reuses a
complete successful body, not an "already applied" marker: a failed local apply
can replay, and pending physical Cash ACKs still retry. A 304 without a cached
body retries unconditionally once. Errors are never replaced with cached success;
a changed licence rejects the in-flight answer.

The original local receive-time anchor travels with cached timer payloads.
Replaying a 304 cannot restart or freeze a running table stopwatch. The server
retains timing/deadline fields in its validator; actively changing clocks may
therefore continue returning 200. Conditional reads save response bytes when
unchanged; they do not claim to avoid the server's authorization/current-state
queries. Cached bodies are still applied idempotently to local mirrors.

Verification for phase 2: 14 transport tests, all 196 bundled PHP tests (998
assertions), and TypeScript/Vite production build passed. A real HostDesk/gateway
headless Edge harness with mocked HTTP/WebSocket measured 20 socket events as
one mirror pull, one Cash pull and one service pull; a duplicate event added no
requests. It also verified unrelated-session filtering, single-flight requests,
stale session/venue fencing, malformed-event recovery and unchanged exact Wheel
approval forwarding. These are test request counts, not measured production
latency. Release the matching cloud endpoint/conditional middleware and rebuild
the OS; confirm real venue request counts and lost-frame/ACK recovery on rollout.
