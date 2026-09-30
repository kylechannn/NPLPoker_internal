# Wheel verification

TDs and ordinary Admins scan the player, photograph or select a clear hand photo, and request a spin. The desk waits for a Super Admin to review the photo on the website or phone. Approval opens the existing wheel; the operator presses **SPIN**. Super Admin operators can spin directly.

The request expires 15 minutes after submission, including time spent waiting for review. One approval authorizes one spin for that player, operator, licensed device, venue and wheel tier. Rejection/expiry requires a new photo and request. A golden follow-up requires a separate approval referencing the original normal spin. Existing eligibility rules and prize issuance are unchanged.

The console retains the operator's admin token for this verification. A stale sign-in prompts for the same operator's password; waiting requests survive reauthentication. Cloud failures stop wheel entry and preserve the reference for a safe retry. The request is consumed only after the backend records the award. A retry of a completed draw retrieves that award rather than issuing another prize.

The photo is uploaded through the existing licensed cloud client with the operator bearer. JPG/PNG/WebP selections are limited to 6 MB, with larger photos resized below 1.5 MB for portable PHP. Camera capture uses the browser/WebView camera permission. The backend stores photos privately and signs temporary review URLs.

Deploy the backend migration `2026_09_30_220000_create_wheel_spin_approvals` and updated OS together. Older OS wheel calls without operator authentication are refused. No local database migration is needed. Backend deployment notes live in `docs/database/MIGRATION_PLAN.md` in NPLPoker_backend.
