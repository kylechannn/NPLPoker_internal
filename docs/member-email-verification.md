# New-member verification at the desk

Desk signup now creates the player/account immediately, without a verification code. The confirmation displays whether verification is pending and whether email delivery succeeded. Staff can register the player for a game immediately. Existing-account claim behavior is unchanged.

Run the Laravel migrations when updating the desk application. `2026_10_02_000100_add_member_verification_to_player_mirror` adds `email_verification_required` (default false) and `can_use_vouchers` (default true). Cloud signup, on-demand resolution, and player delta sync populate these fields. Those defaults preserve legacy players and older cloud payloads. Verification completed elsewhere reaches the mirror through player sync.

The flags describe voucher access only. They do not block roster visibility, normal registration, Cash Games, tournaments, table creation/invites, gameplay, or reward receipt. The cloud applies enrollment only to new accounts. A null verification timestamp is not evidence that a legacy player is restricted.

## Voucher handling

The entitlement response forwards `restriction_code = EMAIL_VERIFICATION_REQUIRED`, `email_verification_required`, and `entitled = false`. Host Desk shows the reason and continues into normal entry. It checks `already_covered` first: an entry already paid using a voucher stays covered. Championship ticket use remains optional; ordinary entry is unchanged.

The player wallet still displays vouchers. Voucher email restriction is indicated only by `email_verification_required`; `can_use_voucher = false` can also mean ordinary expiry, scheduling, or exhaustion.

`POST /api/v1/players/vouchers/{id}/mark-used` now synchronously requests the authoritative cloud redemption. It never queues a new redemption or reports optimistic success. A cloud refusal or outage remains an error. The UI retains the same redemption reference when retrying a failed request, preventing a second spend after a lost response. Existing queue overlays no longer claim a voucher is used before cloud confirmation.

The cloud transport preserves `EMAIL_VERIFICATION_REQUIRED` as a member restriction rather than mapping it to a desk-license error. Voucher redemption endpoints forward that refusal as HTTP 403. Staff cannot override proof of ownership by editing the player's email.

## Validation and rollout

Deploy the cloud verification contract first, then apply the desk migration and rebuild the UI. No legacy players require verification solely because of this release.

- Laravel: `php artisan test --compact --filter=MemberEmailVerificationTest`
- UI: `npm run typecheck` and `npm run build` from `ui`.
- If the Windows sandbox blocks Vite's bundled config loader, run `npm exec -- vite build --configLoader runner` after typechecking.

The feature tests cover no-code signup with failed email delivery, legacy mirror defaults, authoritative success and same-reference retries, cloud refusal/outage without queueing, entitlement restrictions, and preserving existing paid coverage.
