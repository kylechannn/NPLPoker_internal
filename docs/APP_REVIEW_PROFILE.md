# Separate App Review OS profile

App Review uses the existing cloud API and test-only records authorized by the backend. It does not share the venue's local OS installation. Deploy the matching backend first, then build the current OS using the normal build process.

## Prepare and open

```powershell
.\scripts\prepare-app-review.ps1 -BundlePath .\dist -Destination C:\NPL-AppReview
& C:\NPL-AppReview\Start-AppReview.cmd
```

The destination must not exist and must be outside the source bundle. The current build includes `PrepareAppReview.ps1` and a `review-profile-support.json` manifest matched to the executable's SHA-256; preparation refuses older or replaced executables without matching support. Preparation copies program files and dependencies, generates a new local Laravel application key, and creates an empty SQLite database. It excludes the venue `.env`, SQLite journals, cache, queues, sessions, uploaded media, licence, and browser storage. Preparation itself does not launch the OS or contact the cloud.

Use the backend-issued **review CD-Key**, then the assigned review staff credentials. Run **Manual update** to obtain the allowed review venue, players and sessions. Open the appropriate review desk normally. The displayed Admin QR is still the real OS session QR; the mobile app's review-session chooser is available when a reviewer has only one device.

The window and sidebar display **APP REVIEW TEST**. The Go host uses a separate device identity, `review-runtime/license`, `review-runtime/WebView2`, the copy's local SQLite database and framework storage. It serves on loopback port 8988 (or a free fallback port when occupied by an unrelated process), without the venue Caddy/staff gateway. Close an already running review copy before opening the same profile again. Closing the review window shuts down its own PHP workers; opening the normal venue OS restores the ordinary environment without any toggle or data conversion.

Always launch this copy through `Start-AppReview.cmd` (which runs the included PowerShell launcher with a process-only execution policy). Directly opening its executable without the review flag is refused. Setting the flag beside an ordinary unmarked venue install is also refused before its backend starts. A review copy should be upgraded by preparing a new directory from a newly built bundle; do not run the normal venue updater over it or copy in an existing venue database.

## Backend contract

- Licence activate/check requests include `review_profile` as a JSON boolean.
- The cloud rejects a review key from an ordinary profile, or a normal key from a review profile, before allocating a device or issuing a lease.
- Successful `data.license` includes boolean `is_app_review`. The host persists it with the lease. Both Go and the bundled PHP reject a lease whose marker differs from the current profile. Old normal leases with no marker remain normal.
- Every cloud internal endpoint must enforce the test-record allowlist using the review licence. The profile marker is local separation, not a substitute for server authorization.
- The existing realtime descriptor supplies review channel names; the OS uses its returned channel prefixes.
- Fixture dates, session status and live heartbeats still use the existing server rules. Review data needs the backend's documented maintenance process; the OS does not create an unlimited-duration production session.

## Verification

`go test ./...` covers profile-marker startup rejection, unique browser/device identity, inherited database/cache environment removal, and both directions of lease mismatch. `php artisan test --filter ReviewProfileIsolationTest` checks lease access and rejects a mismatched cloud write before HTTP. The UI typecheck covers the review indicator. `scripts/tests/prepare-app-review.test.ps1` verifies that the preparation script excludes planted venue state and refuses an existing destination.

Before distributing the build, open only the prepared review copy, confirm the review marker, activate the review key, run Manual update and inspect the permitted venue/session list. Bind a phone using the displayed QR, then test registration, chat, table service and wheel approval end to end. Verify that a normal member/staff account cannot retrieve or alter those review records. Hardware printing, camera, push delivery, and live cloud authorization require these device checks.
