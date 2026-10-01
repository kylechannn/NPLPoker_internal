# Main Event ticket payment and receipts

The OS uses the backend's Main Event capability and per-session ticket eligibility. There is no ticket-count limit; the backend still enforces the session player limit. Cash and ordinary entry-voucher selection keep their existing rules.

The scan dialog allows multiple eligible tickets and shows the entry fee, ticket coverage and cash deficit. Additional tickets are disabled once the entry is fully covered. Excess value on the final ticket is not returned.

Cloud redemption is one atomic, idempotent payment tied to player, session, device and ticket selection. The same reference safely recovers a lost response. Rescanning finds the existing session payment rather than consuming another ticket batch.

All linked buy-in callers, including phone table-service requests, consult confirmed cloud coverage before recording the sale. Main Event payments and phone confirmations wait for the cloud when coverage cannot be verified. The local ledger records the confirmed deficit and immutable ticket values; a mutable local buy-in price does not change an already paid flight.

Before recording a Main Event buy-in, the OS atomically confirms the entry through the cloud. Once this claim succeeds, the player cannot cancel on their phone and receive the already-used tickets back. A cancellation that wins first stops a voucher-covered booking. For a plain full-fee entry, the claim freezes the operator-configured cash fee and blocks late ticket redemption; if an online ticket payment wins first, its deficit replaces the cash fee. A local failure after confirmation is recovered by rescanning/retrying the same player and session. OS staff can still remove a player through the existing operator flow.

Receipts include the venue, scheduled event date, guarantee, table and seat, player, logo, chips, entry fee, individual ticket codes and values, covered amount, and amount paid at the desk. Fully covered entries and ordinary free-entry vouchers print at $0. Printing time continues to come from the laptop's current system clock at print time.

Deploy the backend migration and API before the OS/client release. Rebuild the desktop host for receipt bridge changes. Test the venue's actual printer, two/three-ticket partial/full coverage, separate flights, a interrupted connection after redemption, and both desk and phone Buy-In confirmation.
