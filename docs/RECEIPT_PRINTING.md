# Receipt layout and data

The desk and admin-phone sale paths share `ReceiptService`. Buy-ins, rebuys,
add-ons and jackpot entry sales keep the existing silent print behaviour.
Printing failure reports `receipt: failed`; it never rolls back a completed sale.
This change does not alter wheel approval or require a jackpot entry to spin.

## Layout

The receipt follows the supplied paper sample, with chips added below the amount:

1. Built-in NPL chip logo and NPL wordmark, centred.
2. Scheduled game date/time, venue, game title and configured guarantee.
3. Optional venue header, then a full-width rule.
4. Large TABLE and SEAT on separate lines, followed by the player's name.
5. Rule, sale type (BUY-IN, REBUY, ADD-ON or JACKPOT ENTRY), large amount paid,
   and the chips supplied by that sale.
6. Any voucher/ticket coverage, print timestamp, `npl.com.au`, optional footer.

The print-test button uses the same layout with explicitly labelled sample
details. A zero-dollar test also confirms that fully covered entries show `$0.00`.
Existing saved custom header/footer text is retained. No extra footer is inserted
when none is saved.

## Authoritative fields

| Field | Source |
| --- | --- |
| Venue and title | Local desk session, falling back to linked cloud session mirror |
| Guarantee | Linked `mirror_game_sessions.payload.guarantee`, including backend per-session overrides |
| Scheduled date/time | Linked mirror `session_date` and `start_time`, interpreted as local wall time |
| Table and seat | `tournament_entries` |
| Name | Recorded entry name, otherwise player NPL ID |
| Amount paid and chips | Recorded `tournament_actions.price_cents` and `chips` for this sale |
| Voucher coverage | Recorded action `meta`, never recalculated from today's voucher template |

A missing guarantee prints `Not specified`; no prize is inferred from the buy-in
or payout ladder. Missing table/seat values print `UNASSIGNED`. Missing start time
does not become midnight. For a local-only session the header uses the actual
`started_at` instant labelled `Started`, or the current date labelled `Date` if
the session has not started.

The printed timestamp uses a valid session payload timezone, then the mirrored
venue's `location_data.timezone`, then `Australia/Sydney` (the cloud scheduling
default). The timezone abbreviation is included and daylight saving follows the
configured timezone. No receipt fields require a new migration or a cloud call.

Rebuy/add-on/jackpot receipts match the supplied idempotency key when present,
so overlapping sales cannot select a newer sale's amount. Buy-ins retain their
one-entry-per-player lookup because legacy buy-in rows do not store that key.

## Printer bridge and rollout

The Go host consumes optional `logo` and `divider` flags in receipt lines alongside
the existing `text`, `center`, `bold` and `big` fields. The logo is bundled with the
OS; printing does not download a remote image. Thermal printers receive an
ESC/POS bitmap and text; document queues receive the same content via the Windows
driver. Long lines wrap to the available width, including double-size text.

Deploy the Go executable and bundled Laravel/UI together. Updating only PHP on an
older Go host leaves a plain `NPL` text fallback instead of the raster logo.

Before using the new build at a venue, select its receipt printer in Overview,
save settings and use **Print a test receipt**. Compare the physical slip to the
sample, checking logo darkness, table/seat size, long-name wrapping and cutter
clearance. Automated payload/byte-stream checks do not establish the physical
printer's font, paper calibration or raster-command compatibility.
