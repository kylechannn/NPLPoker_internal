# Game structure defaults

The desk no longer has a preparation screen. A tournament director, an
admin or a super admin signs in, presses **Open desk** on tonight's session
(Tournament, Cash Game or Events tab) and lands straight in registration.
Prices, rebuy and add-on tiers, caps, the jackpot, the cut-off lines and the
blind ladder all come from the **game structure defaults** — the base setup
a super admin saved on the NPL cloud.

## Who can change what

| Role (cloud admin account) | Opens games | Edits the structure |
| --- | --- | --- |
| Super Admin (`super_admin`) | yes | yes — the **Game Structure** tab |
| Admin (`admin`) | yes | no |
| Tournament Director (`td`) | yes | no |

The tab is visible only to a super admin (`role_key` on the console
sign-in), and the cloud enforces the same rule: the save endpoint sits
behind `admin.role:super_admin`, so nothing a TD or admin does on a desk can
change the defaults.

## Where the data lives

- **Cloud (book of record)**: `os_game_structures` — one row per desk kind,
  `tournament` (settings + `levels`) and `cash` (settings only).
  - `GET/PUT /api/v1/admin/os/game-structure` — super admin, bearer token.
  - `GET /api/v1/internal/game-structure` — every licensed desk (CD-Key).
- **This desk (mirror)**: `game_structure_defaults` — the last pull, so a
  night still opens with the internet down. Until the super admin has saved
  anything, the built-in structure applies (`GameStructureService::builtIn`).

## How it moves

1. **Pull**: `POST /api/v1/console/game-structure/pull` runs at console
   boot and whenever a sessions hub opens; **Manual update** pulls it too
   (stage `game_structure`). Offline is not an error — the mirror stands.
2. **Open**: `POST /api/v1/tournaments/open` with `game_type`,
   `game_session_id`, `venue_id`/`venue_name` (and `replace_session_id`
   for the one-session-at-a-time handshake) builds the full create payload
   from the defaults and opens the draft. The name is the cloud game's
   title, dated ("Fri 26 Sep 2026 — Friday Deepstack").
3. **Save** (super admin only): `PUT /api/v1/console/game-structure`
   carries the super admin's own bearer token (returned by the console
   sign-in as `admin_token`; it is the ONE person-scoped credential the
   console keeps, and only for super admins). The bundled app forwards it
   to the cloud, which validates, stores, audits, and answers with the
   record; the desk mirrors that answer immediately. An expired token
   answers `ADMIN_SIGN_IN_EXPIRED` and the tab asks for the password again.

## Shape

```json
{
  "tournament": {
    "settings": {
      "seats_per_table": 8, "starting_stack": 20000, "buy_in_price_cents": 10000,
      "rebuy_tiers": [{ "price_cents": 10000, "chips": 20000 }], "max_rebuys_per_player": 0,
      "addon_tiers": [{ "price_cents": 5000, "chips": 30000 }], "max_addons_per_player": 1,
      "jackpot_enabled": true, "jackpot_price_cents": 1000,
      "registration_closes_at_level": 6, "rebuy_closes_at_level": null,
      "addon_closes_at_level": null, "jackpot_closes_at_level": null,
      "chip_denominations": "25, 100, 500, 1000",
      "pattern": { "levels": 18, "duration_min": 20, "small_blind": 100, "mode": "multiply", "step": 1.5, "break_every": 6, "break_duration_min": 15, "ante_from_level": 5, "ante_as_big_blind": true }
    },
    "levels": [{ "level_no": 1, "type": "blind", "small_blind": 100, "big_blind": 200, "ante": 0, "bb_ante": 0, "duration_min": 20, "sort_order": 1, "note": null }]
  },
  "cash": {
    "settings": {
      "buy_in_price_cents": 10000, "starting_stack": 10000, "seats_per_table": 8,
      "topups_enabled": true, "rebuy_price_cents": 10000, "rebuy_chips": 10000,
      "jackpot_enabled": false, "jackpot_price_cents": 500,
      "cash_reg_close_min": 0, "cash_jackpot_close_min": 0
    }
  }
}
```

Cut-offs are positions in the ladder (breaks count), exactly as the desk
clock reads them; the cloud refuses a cut-off past the last row.
