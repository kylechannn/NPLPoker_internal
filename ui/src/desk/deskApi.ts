/**
 * The desk's slice of the local API.
 *
 * Everything here talks to the bundled Laravel app on localhost, so there is
 * no auth to carry and no network to lose — but errors still have to surface
 * with the message the service produced, because at a live desk "something
 * went wrong" is useless and "add-ons closed at level 9" is not.
 */

export type Gate = {
  open: boolean
  closes_at_level: number | null
  closes_in_ms: number | null
  reason: string | null
}

export type Gates = {
  registration: Gate
  rebuy: Gate
  addon: Gate
  jackpot: Gate
}

export type DeskOption = {
  action: 'buy_in' | 'rebuy' | 'addon' | 'jackpot'
  label: string
  price_cents: number
  chips: number
  allowed: boolean
  reason: string | null
  /** Which add-on tier this option charges — absent on single-tier games. */
  tier?: number
}

export type AddonTier = {
  price_cents: number
  chips: number
}

export type SeatedPlayer = {
  npl_id: string
  display_name: string
  /**
   * Whether they hold a valid club membership ID for this venue.
   * Null = no register data — the desk shows nothing rather than flagging
   * the whole room.
   */
  club_member?: boolean | null
  status: 'active' | 'eliminated'
  table_number: number | null
  seat_number: number | null
  finish_position: number | null
  in_jackpot: boolean
  rebuys: number
  addons: number
  max_rebuys: number
  max_addons: number
  spend_cents: number
}

export type DeskTable = {
  table_number: number
  occupied: number
  seats: Array<{ seat_number: number, player: SeatedPlayer | null }>
}

export type Seating = {
  seats_per_table: number
  game_session_id: number | null
  rebuy_tiers: AddonTier[]
  tables: DeskTable[]
  unseated: SeatedPlayer[]
  eliminated: SeatedPlayer[]
  counts: {
    entries: number
    active: number
    eliminated: number
    in_jackpot: number
    total_players?: number
    active_players?: number
    total_chips?: number
  }
  gates: Gates
  clock: Record<string, unknown>
}

export type OnlineBooking = {
  table_number: number
  seat_number: number | null
  status: string | null
  waitlist_position: number | null
}

export type ScanResult = {
  player: { npl_id: string, display_name: string, avatar_url: string | null, state_code: string | null }
  entry: SeatedPlayer | null
  booking: OnlineBooking | null
  options: DeskOption[]
  gates: Gates
}

export type Venue = {
  id: number
  name: string | null
  state_code: string | null
  suburb: string | null
  media_key: string | null
}

export type GeneratedLevel = {
  level_no: number
  type: 'blind' | 'break'
  small_blind: number
  big_blind: number
  ante: number
  bb_ante: number
  duration_min: number
  sort_order: number
  note: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string }, errors?: Record<string, string[]> }
    | null

  if (!response.ok) {
    // Laravel puts the useful sentence in the first field error; the generic
    // "The given data was invalid" is never the thing the operator needs.
    const fieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    throw new Error(fieldError ?? body?.error?.message ?? body?.message ?? `Request failed (${response.status})`)
  }

  return body?.data as T
}

export type UpcomingSession = {
  session_id: number
  title: string | null
  category: string | null
  source_type: string | null
  venue_id: number | null
  venue_name: string | null
  session_date: string | null
  start_time: string | null
  registrations_count: number
  max_players: number | null
  tables_count: number
  local_tournament_id: number | null
  local_tournament_status: string | null
}

export type RosterPlayer = {
  npl_id: string
  display_name: string | null
  seat_number: number | null
  status: string | null
  waitlist_position: number | null
}

export type RosterTable = {
  table_number: number
  status: string | null
  max_seats: number
  players: RosterPlayer[]
}

export type DeskVoucher = {
  id: number
  code: string
  type: string
  title: string | null
  unlimited_uses: boolean
  uses_remaining: number | null
  expires_at: string | null
}

export const deskApi = {
  venues: () => request<{ venues: Venue[] }>('/api/v1/desk/venues'),

  /** Live cloud check on scan: does this player enter free? */
  voucherEntitlement: (nplId: string, venueId: number | null) =>
    request<{ entitled: boolean, voucher: DeskVoucher | null, offline: boolean }>('/api/v1/vouchers/entitlement', {
      method: 'POST',
      body: JSON.stringify({ npl_id: nplId, venue_id: venueId }),
    }),

  /** One-tap apply — idempotent by reference, safe to retry. */
  voucherRedeem: (reference: string, nplId: string, voucherId: number | null, venueId: number | null) =>
    request<{ voucher: DeskVoucher | null }>('/api/v1/vouchers/redeem', {
      method: 'POST',
      body: JSON.stringify({ reference, npl_id: nplId, voucher_id: voucherId, venue_id: venueId }),
    }),

  /** Cloud-scheduled sessions still ahead for the venue — express entry list. */
  upcomingSessions: (venueId: number | null) =>
    request<{ venue_id: number | null, sessions: UpcomingSession[] }>(
      `/api/v1/desk/upcoming-sessions${venueId ? `?venue_id=${venueId}` : ''}`,
    ),

  dashboard: (venueId: number | null) =>
    request<{ venue_id: number | null, sessions: Array<Record<string, unknown>>, players_mirrored: number }>(
      `/api/v1/desk/dashboard${venueId ? `?venue_id=${venueId}` : ''}`,
    ),

  previewStructure: (options: Record<string, unknown>) =>
    request<{ levels: GeneratedLevel[], preview: string[], total_minutes: number }>(
      '/api/v1/desk/structure-preview',
      { method: 'POST', body: JSON.stringify(options) },
    ),

  /** Full tournament detail — config, levels, clock. */
  tournament: (sessionId: number) =>
    request<{ session: Record<string, unknown>, levels: GeneratedLevel[], clock: Record<string, unknown> }>(
      `/api/v1/tournaments/${sessionId}`,
    ),

  /** Draft-only settings edit: the prep screen re-opened before Start. */
  updateTournament: (sessionId: number, payload: Record<string, unknown>) =>
    request<{ session: { id: number, name: string, status: string } }>(`/api/v1/tournaments/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),

  createTournament: (payload: Record<string, unknown>) =>
    request<{ session: { id: number, name: string, status: string } }>('/api/v1/tournaments', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  scan: (sessionId: number, nplId: string) =>
    request<ScanResult>(`/api/v1/desk/${sessionId}/scan`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId }),
    }),

  /** Online roster for one cloud session, from the live mirror. */
  sessionRoster: (gameSessionId: number) =>
    request<{ session_id: number, tables: RosterTable[] }>(`/api/v1/desk/sessions/${gameSessionId}/roster`),

  /** Cancel a cloud table (players get inbox notices, wait-lists resolve). */
  cancelCloudTable: (gameSessionId: number, tableNumber: number) =>
    request<{ result: Record<string, unknown> }>(`/api/v1/desk/sessions/${gameSessionId}/tables/${tableNumber}`, { method: 'DELETE' }),

  /** Remove a player's online registration for a cloud session. */
  removeCloudRegistration: (gameSessionId: number, nplId: string) =>
    request<{ result: Record<string, unknown> }>(
      `/api/v1/desk/sessions/${gameSessionId}/registrations/${encodeURIComponent(nplId)}`,
      { method: 'DELETE' },
    ),

  /** Finish the game: record top placements and push standings to the cloud. */
  finalise: (sessionId: number, placements: Array<{ npl_id: string, position: number }>) =>
    request<{ result: { finished: boolean, pushed: boolean, queued: boolean, name: string, venue_name: string | null, recorded: number } }>(
      `/api/v1/desk/${sessionId}/finalise`,
      { method: 'POST', body: JSON.stringify({ placements }) },
    ),

  /** Open a new table in the cloud for a linked session. */
  createTable: (sessionId: number) =>
    request<{ table: Record<string, unknown>, seating: Seating }>(`/api/v1/desk/${sessionId}/tables`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  act: (sessionId: number, nplId: string, action: string, extra: Record<string, unknown> = {}) =>
    request<{ seating: Seating }>(`/api/v1/desk/${sessionId}/act`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId, action, ...extra }),
    }),

  seating: (sessionId: number) => request<Seating>(`/api/v1/desk/${sessionId}/seating`),

  eliminate: (sessionId: number, nplId: string) =>
    request<Seating>(`/api/v1/desk/${sessionId}/eliminate`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId }),
    }),

  reinstate: (sessionId: number, nplId: string) =>
    request<Seating>(`/api/v1/desk/${sessionId}/reinstate`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId }),
    }),

  /** Kick a player out of the session entirely (local + cloud registration). */
  removePlayer: (sessionId: number, nplId: string) =>
    request<{ seating: Seating }>(`/api/v1/desk/${sessionId}/remove-player`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId }),
    }).then((result) => result.seating),

  seat: (sessionId: number, nplId: string, tableNumber: number | null, seatNumber: number | null) =>
    request<Seating>(`/api/v1/desk/${sessionId}/seat`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId, table_number: tableNumber, seat_number: seatNumber }),
    }),

  startClock: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/start`, { method: 'POST' }),

  pauseClock: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/pause`, { method: 'POST' }),

  resumeClock: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/resume`, { method: 'POST' }),

  nextLevel: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/next-level`, { method: 'POST' }),

  previousLevel: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/previous-level`, { method: 'POST' }),
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`
}

export function countdown(ms: number | null): string {
  if (ms === null) return '—'
  const total = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
