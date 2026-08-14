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
  /** The venue's own membership code, present only when club_member is true. */
  club_member_code?: string | null
  /** The player mirror's avatar, straight from the cloud — same as the scan card. */
  avatar_url?: string | null
  /** Admin-counted live stack — null/absent means "not counted", never zero. */
  live_chips?: number | null
  /** ISO time the stack was counted, straight from the cloud. */
  live_chips_at?: string | null
  /**
   * 'online' = a cloud booking holding the seat before desk buy-in —
   * shown with a PRE tag, never draggable, no desk actions.
   */
  status: 'active' | 'eliminated' | 'online'
  /** True until desk check-in (or a voucher) secures the online seat. */
  pre_registered?: boolean
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

/**
 * Table-level meta mirrored from the cloud on every table object —
 * player-created private cash tables carry a creator, game mode, blinds
 * and a gathering deadline. All optional: unlinked (ad-hoc) sessions and
 * pre-migration mirrors simply omit them.
 */
export type TableMirrorMeta = {
  table_kind?: 'house' | 'private' | null
  creator_npl_id?: string | null
  creator_display_name?: string | null
  game_mode?: string | null
  blinds_text?: string | null
  rules_text?: string | null
  allow_strangers?: boolean | null
  activation_deadline_at?: string | null
  activated_at?: string | null
}

/**
 * Whole minutes left for a private table to gather its players — null
 * unless the table is private, not yet activated, and the deadline is
 * still ahead. Coarse by design: the grids refresh every ~15s anyway.
 */
export const privateGatherMinutes = (table: TableMirrorMeta): number | null => {
  if (table.table_kind !== 'private' || table.activated_at || !table.activation_deadline_at) return null
  const deadline = Date.parse(table.activation_deadline_at)
  if (!Number.isFinite(deadline)) return null
  const remaining = deadline - Date.now()
  return remaining > 0 ? Math.max(1, Math.ceil(remaining / 60_000)) : null
}

export type DeskTable = TableMirrorMeta & {
  table_number: number
  occupied: number
  seats: Array<{ seat_number: number, player: SeatedPlayer | null }>
}

export type Seating = {
  seats_per_table: number
  game_session_id: number | null
  rebuy_tiers: AddonTier[]
  addon_tiers: AddonTier[]
  buy_in: AddonTier
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
    total_rebuys?: number
    total_addons?: number
    average_stack?: number
    /** How many players an admin phone has counted so far. */
    counted_players?: number
    /** Sum of the counted stacks — null while nobody has been counted. */
    counted_chips_total?: number | null
  }
  gates: Gates
  clock: Record<string, unknown>
  /** Room-display extras — chips typed at the desk, prizes from the cloud game. */
  display?: {
    chip_denominations: string | null
    prize_breakdown: PrizeBreakdownRow[] | null
    /** The game's guarantee money text (e.g. "$10,000") — tops the rail. */
    prize_guarantee: string | null
    /** THIS session's own winner-voucher ladder — configured per session, not per venue. */
    winner_vouchers: WinnerVoucherRow[] | null
  }
}

/** One payout row of the linked cloud game (Daily Games admin). */
export type PrizeBreakdownRow = {
  place: string
  prize: string
}

/** One rung of the linked cloud session's winner-voucher ladder. */
export type WinnerVoucherRow = {
  position: number
  label: string
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

export type SessionSummary = {
  session_id: number
  title: string | null
  category: string | null
  venue_id: number | null
  venue_name: string | null
  session_date: string
  start_time: string | null
  status: string
  registrations_count: number
  max_players: number | null
}

/** An online registration already paid with a voucher — the desk collects
 *  only the over-limit difference, and never redeems a second time. A
 *  championship ticket stack carries its totals: collect deficit_cents. */
export type OnlineCoverage = {
  voucher_id?: number
  code: string
  type: string
  title?: string | null
  entry_fee_limit_cents: number | null
  vouchers?: { voucher_id: number, code: string, type: string, title: string | null, value_cents: number | null, entry_fee_limit_cents: number | null }[]
  covered_cents?: number | null
  deficit_cents?: number | null
}

export type OnlineRegistration = {
  npl_id: string
  display_name: string
  status: 'registered' | 'waitlisted'
  /** True until desk check-in (or a voucher) secures the seat. */
  pre_registered?: boolean
  /** A hand-picked invitation seat on a special event — confirmed, no voucher. */
  invited_entry?: boolean
  registered_at: string | null
  waitlist_position: number | null
  table_number: number | null
  seat_number: number | null
  /** Entry already paid online with a voucher — never charge it again. */
  covered_by_voucher?: {
    code: string
    type: string
    entry_fee_limit_cents: number | null
    covered_cents?: number | null
    deficit_cents?: number | null
  } | null
}

export type Venue = {
  id: number
  name: string | null
  state_code: string | null
  suburb: string | null
  media_key: string | null
}

/** One cash-game chat line from the cloud — table-room talk or a TD thread. */
export type ChatRecentRow = {
  id: number
  game_session_id: number
  session_title: string | null
  session_date: string | null
  scope: 'table' | 'td'
  sender: 'player' | 'td'
  sender_name: string | null
  npl_id: string | null
  thread: { player_id: number, npl_id: string | null, display_name: string | null } | null
  body: string
  created_at: string
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
  /** 'tournament' | 'cash' — how the already-opened local desk runs. */
  local_tournament_game_type?: string | null
}

export type RosterPlayer = {
  npl_id: string
  display_name: string | null
  seat_number: number | null
  status: string | null
  waitlist_position: number | null
}

export type RosterTable = TableMirrorMeta & {
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
  /** Ticket face value (cash prize / special ticket), in cents. */
  value_cents?: number | null
  /**
   * Entry types: buy-ins at or under this are fully covered; dearer games
   * charge the player the difference. Null/absent = covers any buy-in.
   */
  entry_fee_limit_cents?: number | null
}

/** One table-service request as the cloud describes it. */
export type ServiceRequestRow = {
  id: number
  kind: string
  status: string
  note: string | null
  npl_id: string
  display_name: string | null
  table_number: number | null
  seat_number: number | null
  amount_cents: number | null
  claimed_by_name: string | null
  entry_voucher_label: string | null
  resolved_by_name: string | null
  applied_at: string | null
  apply_error: string | null
  created_at: string | null
}

/** This session's cloud identity — what the Admin QR encodes. */
export type AdminQr = {
  tournament_uid: string
  game_session_id: number | null
  venue_id: number | null
  venue_name: string | null
  name: string | null
}

/**
 * The room's single unfinished session. Only one can exist at a time —
 * tournament or cash — so this doubles as "may a new session be created"
 * and as the sidebar admin QR's data source.
 */
export type ActiveSession = {
  id: number
  name: string | null
  game_type: 'tournament' | 'cash'
  status: 'draft' | 'running' | 'paused'
  venue_name: string | null
  game_session_id: number | null
  qr: AdminQr
}

/** The desk→cloud call queue, as the shell's sync badge sees it. */
export type CloudQueueDeadItem = {
  id: number
  label: string
  last_error: string | null
  attempts: number
  updated_at: string
}

export type CloudQueueStatus = {
  pending: number
  dead: number
  dead_items: CloudQueueDeadItem[]
  /** The money outbox's dead letters — the ones that MUST get eyes. */
  outbox_dead: CloudQueueDeadItem[]
  outbox_dead_count: number
}

export const deskApi = {
  venues: () => request<{ venues: Venue[] }>('/api/v1/desk/venues'),

  /** Queue health for the statusbar — pending on the way, dead need eyes. */
  cloudQueueStatus: () => request<CloudQueueStatus>('/api/v1/cloud-queue/status'),

  /** Put a dead job back in line. */
  cloudQueueRetry: (id: number) =>
    request<{ retried: boolean }>(`/api/v1/cloud-queue/${id}/retry`, { method: 'POST', body: JSON.stringify({}) }),

  /** Drop a dead job for good. */
  cloudQueueDiscard: (id: number) =>
    request<{ discarded: boolean }>(`/api/v1/cloud-queue/${id}`, { method: 'DELETE' }),

  /** Same controls for the money outbox's dead letters. */
  cloudQueueRetryOutbox: (id: number) =>
    request<{ retried: boolean }>(`/api/v1/cloud-queue/outbox/${id}/retry`, { method: 'POST', body: JSON.stringify({}) }),

  cloudQueueDiscardOutbox: (id: number) =>
    request<{ discarded: boolean }>(`/api/v1/cloud-queue/outbox/${id}`, { method: 'DELETE' }),

  /** Live cloud check on scan: does this player enter free? On a
   *  championship it also lists the stackable special tickets + the price. */
  voucherEntitlement: (nplId: string, venueId: number | null, gameSessionId: number | null = null) =>
    request<{
      entitled: boolean
      voucher: DeskVoucher | null
      already_covered?: OnlineCoverage | null
      special_tickets?: DeskVoucher[] | null
      entry_fee_cents?: number | null
      // The status-tier window: player holds a voucher their tier can't
      // use this early — show the operator when it opens.
      voucher_locked?: boolean
      voucher_available_from?: string | null
      voucher_tier?: string | null
      voucher_tier_hours?: number | null
      offline: boolean
    }>('/api/v1/vouchers/entitlement', {
      method: 'POST',
      body: JSON.stringify({ npl_id: nplId, venue_id: venueId, game_session_id: gameSessionId }),
    }),

  /** One-tap apply — idempotent by reference, safe to retry. Pass
   *  voucherIds to consume a championship ticket stack in one batch. */
  voucherRedeem: (reference: string, nplId: string, voucherId: number | null, venueId: number | null, gameSessionId: number | null = null, voucherIds: number[] | null = null) =>
    request<{ voucher: DeskVoucher | null, vouchers?: DeskVoucher[] | null, covered_cents?: number | null }>('/api/v1/vouchers/redeem', {
      method: 'POST',
      body: JSON.stringify({
        reference,
        npl_id: nplId,
        voucher_id: voucherId,
        ...(voucherIds && voucherIds.length ? { voucher_ids: voucherIds } : {}),
        venue_id: venueId,
        game_session_id: gameSessionId,
      }),
    }),

  /** Cloud-scheduled sessions still ahead for the venue — express entry list. */
  upcomingSessions: (venueId: number | null) =>
    request<{ venue_id: number | null, sessions: UpcomingSession[] }>(
      `/api/v1/desk/upcoming-sessions${venueId ? `?venue_id=${venueId}` : ''}`,
    ),

  /** Every synced session — the Registrations tab groups these by date. */
  allSessions: (venueId: number | null) =>
    request<{ sessions: SessionSummary[] }>(
      `/api/v1/desk/all-sessions${venueId ? `?venue_id=${venueId}` : ''}`,
    ),

  /** Live online registration record: names, NPL IDs, times. */
  onlineRegistrations: (gameSessionId: number) =>
    request<{ result: { registrations: OnlineRegistration[] } }>(
      `/api/v1/desk/sessions/${gameSessionId}/online-registrations`,
    ).then((data) => data.result.registrations),

  /** Recent cash-game chat — table rooms + TD requests, newest first. */
  chatRecent: (venueId: number | null) =>
    request<{ result: { data: ChatRecentRow[] } }>(
      `/api/v1/desk/chat/recent${venueId ? `?venue_id=${venueId}` : ''}`,
    ).then((r) => r.result.data),

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

  /** The Admin QR payload: how the iOS admin app addresses this session. */
  adminQr: (sessionId: number) =>
    request<{ qr: AdminQr }>(`/api/v1/tournaments/${sessionId}/admin-qr`),

  /** The room's one unfinished session — null when the desk is idle. */
  activeSession: () =>
    request<{ active: ActiveSession | null }>('/api/v1/tournaments/active')
      .then((data) => data.active),

  /** Abandon a mistaken draft — refused once anyone has bought in. */
  discardTournament: (sessionId: number) =>
    request<{ discarded: boolean }>(`/api/v1/tournaments/${sessionId}`, { method: 'DELETE' }),

  /** One pull: apply admin-resolved money kinds + the desk's own queue. */
  serviceSync: (sessionId: number) =>
    request<{
      applied: {
        id: number
        npl_id: string
        kind: string
        table_number: number | null
        /** printed | failed | disabled — the silent receipt's fate. */
        receipt?: string | null
      }[]
      failed: { id: number, npl_id: string, kind: string, error: string }[]
      pending: ServiceRequestRow[]
      recent: ServiceRequestRow[]
    }>(`/api/v1/desk/${sessionId}/service-sync`, { method: 'POST', body: JSON.stringify({}) }),

  /** The desk handles a phone request itself — ledger first, then cloud. */
  serviceHandle: (sessionId: number, requestId: number) =>
    request<{ handled: { id: number, kind: string, npl_id: string }, seating: Seating }>(
      `/api/v1/desk/${sessionId}/service-handle`,
      { method: 'POST', body: JSON.stringify({ request_id: requestId }) },
    ),

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

  /** Move a wait-listed player into the first free seat, cloud-side. */
  promoteCloudRegistration: (gameSessionId: number, nplId: string) =>
    request<{ result: Record<string, unknown> }>(
      `/api/v1/desk/sessions/${gameSessionId}/registrations/${encodeURIComponent(nplId)}/promote`,
      { method: 'POST', body: JSON.stringify({}) },
    ),

  /** Finish the game: record top placements and push standings to the cloud. */
  finalise: (sessionId: number, placements: Array<{ npl_id: string, position: number }>) =>
    request<{ result: { finished: boolean, pushed: boolean, queued: boolean, name: string, venue_name: string | null, recorded: number } }>(
      `/api/v1/desk/${sessionId}/finalise`,
      { method: 'POST', body: JSON.stringify({ placements }) },
    ),

  /** Stop a private table's gather countdown — the table then stays for good. */
  stopCountdown: (gameSessionId: number, tableNumber: number) =>
    request<{ result: Record<string, unknown> }>(
      `/api/v1/desk/sessions/${gameSessionId}/tables/${tableNumber}/stop-countdown`,
      { method: 'POST', body: JSON.stringify({}) },
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
