# Public cash table setup at the OS desk

An unopened public cash table now offers **OPEN** and **CLOSE**. OPEN asks for the same game type and blinds/buy-in choices used by the player flow, plus optional table rules. There is no private-access option. Confirming opens the table with zero players and no gathering countdown; it creates no member registration. Staff opening is available after the online registration cutoff, while completed/cancelled sessions remain closed.

An admin-closed table still cannot be reopened by a player. Staff reopening preserves existing settings; an unused table requires setup. Player-created private tables retain their existing four-player activation and invitation/privacy behavior.

Initial setup requires a cloud response and refreshes authoritative seating; a failed/offline request leaves the table unopened. Existing configured table open/close/timer operations retain their queue behavior. The backend controls table capacity, including restoring cancelled tables and reserving closed slots, and rejects web-admin cash-table state/cancellation requests.

Apply local migration `2026_10_01_000300_add_cash_setup_to_mirror_tables` through the normal OS updater. It adds nullable `setup_required` to both live and staging seating tables so full snapshot swaps remain compatible. Only known unopened rows are backfilled. Other rows receive the true value from the updated cloud seating response; do not infer missing rules or rewrite existing configurations. Deploy the updated backend first.

Validation: OS cash/timer/desk regression tests exercise settings submission, cloud-confirmed state, zero-player opening, denied offline setup, mirror schema parity and unchanged configured-table controls. Backend tests additionally cover signup cutoff, closed/cancelled capacity, licence venue boundaries, completed sessions, daily/event behavior and private-table activation.
