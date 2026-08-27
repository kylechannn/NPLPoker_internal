# Feedback & Reports

The desk's line to NPL head office: bug reports, feedback and feature
requests, sent from the **Support → Feedback & Reports** tab and read in the
website admin console (`/api/v1/admin/os-feedback`).

## How a report travels

1. The UI (`ui/src/feedback/`) posts `{ category, severity?, subject,
   message, author_name?, venue_id?, context? }` to the local Laravel app at
   `POST /api/v1/feedback`.
2. `FeedbackController::store` validates, mints a `client_reference` (UUID),
   stamps `os_version` from `config('app.version')` (the Go host's build),
   and enqueues `POST /api/v1/internal/feedback` on the cloud call queue with
   group `feedback:<uuid>`. The operator's click never waits for the cloud.
3. The drains sweeper lands it within seconds when the link is green. Offline
   it waits in the queue (visible in the shell's queue panel) and sends on
   reconnect; the cloud is idempotent on `client_reference`, so a retry never
   files the same report twice.

## Reading back

`GET /api/v1/feedback` returns `{ available, reports, pending }`:

- `reports` — this licence's reports from the cloud, newest first (max 50),
  each with `status` (`new` / `acknowledged` / `resolved` / `closed`) and the
  admin's `admin_notes` reply.
- `pending` — rows still in `cloud_call_queue` for the feedback path, so the
  operator sees what they sent even before it lands.
- `available: false` when the cloud could not be reached; the pending list is
  still returned and the tab shows a quiet banner instead of an error.

## Diagnostics

With "Include this install's diagnostics" ticked (default), the report's
`context` carries: OS version, resource profile, network grade / latency /
reliability, venue id + name, signed-in operator name + role, screen size,
user agent and a timestamp. The tab shows the exact list before sending. The
local controller refuses a context above 16 000 JSON bytes (the cloud's cap)
with a 422 rather than letting the job dead-letter later.

Tests: `app/npl_internal/tests/Feature/FeedbackTest.php`.
