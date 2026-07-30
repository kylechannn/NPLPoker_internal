/**
 * Player operations: roster search (offline-capable, local mirror), staff
 * comments and desk registration (both cloud-direct — link must be green).
 */

export type RosterPlayer = {
  npl_id: string
  display_name: string
  public_player_code: string | null
  state_code: string | null
  avatar_media_key: string | null
  status: string
  club_member_code: string | null
}

export type PlayerComment = {
  id: number
  venue_id: number | null
  venue_name: string | null
  author_name: string
  note: string
  created_at: string
}

export type CommentsResult = {
  /** False when the cloud could not be reached — unknown, not "none". */
  available: boolean
  comments: PlayerComment[]
  truncated: boolean
}

export type DeskVoucher = {
  id: number
  code: string
  type: string
  title: string | null
  max_uses: number
  unlimited_uses: boolean
  uses_count: number
  uses_remaining: number | null
  starts_at: string | null
  expires_at: string | null
  status: string
  last_redemption: { handled_by: string | null, source: string | null, redeemed_at: string | null } | null
}

export type RegisteredPlayer = {
  id: number
  npl_id: string
  public_player_code: string
  display_name: string
  state_code: string | null
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
    const fieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    throw new Error(fieldError ?? body?.error?.message ?? body?.message ?? `Request failed (${response.status})`)
  }

  return body?.data as T
}

export const playersApi = {
  search: (query: string, venueId: number | null) =>
    request<{ players: RosterPlayer[] }>(
      `/api/v1/players?query=${encodeURIComponent(query)}${venueId !== null ? `&venue_id=${venueId}` : ''}`,
    ),

  comments: (nplId: string) =>
    request<CommentsResult>(`/api/v1/players/comments?npl_id=${encodeURIComponent(nplId)}`),

  addComment: (nplId: string, note: string, authorName: string | null, venueId: number | null) =>
    request<{ result: unknown }>('/api/v1/players/comments', {
      method: 'POST',
      body: JSON.stringify({ npl_id: nplId, note, author_name: authorName, venue_id: venueId }),
    }),

  deleteComment: (cloudId: number) =>
    request<{ result: unknown }>(`/api/v1/players/comments/${cloudId}`, { method: 'DELETE' }),

  updatePlayer: (form: Record<string, string>) =>
    request<{ result: { player: unknown } }>('/api/v1/players/update', {
      method: 'POST',
      body: JSON.stringify(form),
    }),

  setPassword: (nplId: string, password: string, confirmation: string) =>
    request<{ result: unknown }>('/api/v1/players/password', {
      method: 'POST',
      body: JSON.stringify({ npl_id: nplId, password, password_confirmation: confirmation }),
    }),

  vouchers: (nplId: string) =>
    request<{ result: { vouchers: DeskVoucher[] } }>(`/api/v1/players/vouchers?npl_id=${encodeURIComponent(nplId)}`)
      .then((data) => ({ vouchers: data.result.vouchers })),

  markVoucherUsed: (voucherId: number, nplId: string, handledBy: string | null) =>
    request<{ result: { voucher: DeskVoucher } }>(`/api/v1/players/vouchers/${voucherId}/mark-used`, {
      method: 'POST',
      body: JSON.stringify({
        npl_id: nplId,
        handled_by: handledBy,
        // Idempotent by reference: a double-click can never consume twice.
        reference: `DM-${crypto.randomUUID().replace(/-/g, '').slice(0, 24).toUpperCase()}`,
      }),
    }),

  registerCode: (email: string) =>
    request<{ result: unknown }>('/api/v1/players/register-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  register: (form: Record<string, string | null>) =>
    request<{ result: { player: RegisteredPlayer } }>('/api/v1/players/register', {
      method: 'POST',
      body: JSON.stringify(form),
    }),
}
