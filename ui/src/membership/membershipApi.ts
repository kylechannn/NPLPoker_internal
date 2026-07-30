/**
 * Club Membership IDs — the venue's own member register. Reads come back
 * from the local mirror (rewritten from the cloud on every load); writes go
 * to the cloud synchronously and need the backend link green.
 */

export type ClubMembership = {
  id: number
  cloud_id: number
  venue_id: number
  npl_id: string
  display_name: string | null
  club_member_code: string
  status: 'active' | 'inactive' | 'expired'
  valid: boolean | number
  joined_at: string | null
  expires_at: string | null
  notes: string | null
}

export type MembershipRegister = {
  source: 'cloud' | 'mirror'
  memberships: ClubMembership[]
}

export type ResolvedMember = {
  player: { npl_id: string, display_name: string, state_code: string | null }
  membership: ClubMembership | null
}

export type MembershipDraft = {
  venue_id: number
  npl_id: string
  club_member_code: string
  status?: 'active' | 'inactive' | 'expired'
  joined_at?: string | null
  expires_at?: string | null
  notes?: string | null
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

export const membershipApi = {
  register: (venueId: number) =>
    request<MembershipRegister>(`/api/v1/membership?venue_id=${venueId}`),

  resolve: (venueId: number, id: string) =>
    request<ResolvedMember>('/api/v1/membership/resolve', {
      method: 'POST',
      body: JSON.stringify({ venue_id: venueId, id }),
    }),

  save: (draft: MembershipDraft) =>
    request<{ memberships: ClubMembership[] }>('/api/v1/membership', {
      method: 'POST',
      body: JSON.stringify(draft),
    }),

  remove: (cloudId: number, venueId: number) =>
    request<{ memberships: ClubMembership[] }>(`/api/v1/membership/${cloudId}?venue_id=${venueId}`, {
      method: 'DELETE',
    }),
}
