# Public cash table setup at the OS desk

An unopened public cash table now offers **OPEN** and **CLOSE**. OPEN asks for the same game type and blinds/buy-in choices used by the player flow, plus optional table rules. There is no private-access option. Confirming opens the table with zero players and no gathering countdown; it creates no member registration. Staff opening is available after the online registration cutoff, while completed/cancelled sessions remain closed.

An admin-closed table still cannot be reopened by a player. Staff reopening preserves existing settings; an unused table requires setup. Player-created private tables retain their existing four-player activation and invitation/privacy behavior.

Initial setup requires a cloud response and refreshes authoritative seating; a failed/offline request leaves the table unopened. Existing configured table open/close/timer operations retain their queue behavior. The backend controls table capacity, including restoring cancelled tables and reserving closed slots, and rejects web-admin cash-table state/cancellation requests.

Apply local migration `2026_10_01_000300_add_cash_setup_to_mirror_tables` through the normal OS updater. It adds nullable `setup_required` to both live and staging seating tables so full snapshot swaps remain compatible. Only known unopened rows are backfilled. Other rows receive the true value from the updated cloud seating response; do not infer missing rules or rewrite existing configurations. Deploy the updated backend first.

Validation: OS cash/timer/desk regression tests exercise settings submission, cloud-confirmed state, zero-player opening, denied offline setup, mirror schema parity and unchanged configured-table controls. Backend tests additionally cover signup cutoff, closed/cancelled capacity, licence venue boundaries, completed sessions, daily/event behavior and private-table activation.

## Multiple reservations within one Cash Game session

Players may reserve seats at several tables while retaining one current playing table. Checking in or moving tables keeps other future reservations. A later reserved table going live creates its own five-minute player choice: move or give up that reservation. No answer releases only that target; the current table and other future reservations remain. Daily games, tournaments and events keep their existing registration flow.

The desk shows all Cash reservations, including bookings on other tables for a player who has already bought in. Online registration removal/promotion addresses `registration_id` and table number. Phone scan-in exposes the same choices and cannot silently choose the first of several reservations.

When a checked-in player accepts a move, the cloud reserves both seats and issues a durable move command. The open Cash desk polls every five seconds and on reconnection/focus, applies the seat change without another buy-in or any chip/money ledger change, then acknowledges it. A lost acknowledgement retries from the local journal, even if the completed command is no longer in the feed. A destination occupied at the desk fails the move and keeps the previous seat. Pending local moves protect both seats from manual changes. The authoritative cloud position also repairs stale offline seat updates after pending desk writes finish.

Deploy the updated backend and its Cash reservation migration first. Apply local migration `2026_10_02_000100_add_cash_table_moves` through the OS updater; it adds registration identity/state/version to both mirror tables, versioned local entries, the move acknowledgement journal and recovery snapshots for rejected offline removals/eliminations. Recovery restores an existing paid entry or clears its stale physical seat, then refreshes the desk and tells staff to review the updated position without charging again. Cash check-in/seat/cancellation outbox messages carry registration identity and version so old queued operations cannot overwrite newer player choices. Keep the Cash desk open and online to finish physical transfers; clients show **waiting for the venue desk** until acknowledgement.

Validation covers successful transfer, lost-ACK replay, occupied destination, cloud rejection rollback, authoritative recovery, unchanged financial ledger, other-table booking visibility and non-Cash exclusion.
