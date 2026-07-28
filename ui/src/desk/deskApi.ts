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
}

export type SeatedPlayer = {
  npl_id: string
  display_name: string
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
    average_stack?: number
    total_chips?: number
  }
  gates: Gates
  clock: Record<string, unknown>
}

export type ScanResult = {
  player: { npl_id: string, display_name: string, avatar_url: string | null, state_code: string | null }
  entry: SeatedPlayer | null
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
    | { ok?: boolean, data?: T, message?: string, errors?: Record<string, string[]> }
    | null

  if (!response.ok) {
    // Laravel puts the useful sentence in the first field error; the generic
    // "The given data was invalid" is never the thing the operator needs.
    const fieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    throw new Error(fieldError ?? body?.message ?? `Request failed (${response.status})`)
  }

  return body?.data as T
}

export const deskApi = {
  venues: () => request<{ venues: Venue[] }>('/api/v1/desk/venues'),

  dashboard: (venueId: number | null) =>
    request<{ venue_id: number | null, sessions: Array<Record<string, unknown>>, players_mirrored: number }>(
      `/api/v1/desk/dashboard${venueId ? `?venue_id=${venueId}` : ''}`,
    ),

  previewStructure: (options: Record<string, unknown>) =>
    request<{ levels: GeneratedLevel[], preview: string[], total_minutes: number }>(
      '/api/v1/desk/structure-preview',
      { method: 'POST', body: JSON.stringify(options) },
    ),

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

  seat: (sessionId: number, nplId: string, tableNumber: number | null, seatNumber: number | null) =>
    request<Seating>(`/api/v1/desk/${sessionId}/seat`, {
      method: 'POST',
      body: JSON.stringify({ player_npl_id: nplId, table_number: tableNumber, seat_number: seatNumber }),
    }),

  startClock: (sessionId: number) =>
    request<Record<string, unknown>>(`/api/v1/tournaments/${sessionId}/start`, { method: 'POST' }),
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
