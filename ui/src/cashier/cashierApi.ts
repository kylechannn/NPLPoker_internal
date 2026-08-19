// The Cashier tab's local feed: sessions and one session's money grid,
// read entirely off the desk's own ledger — no internet required.

export type CashierSession = {
  id: number
  name: string
  venue_name: string | null
  status: string
  game_type: 'tournament' | 'cash'
  created_at: string | null
  started_at: string | null
  finished_at: string | null
}

export type CashierCell = { count: number, cents: number }

export type CashierPlayerRow = {
  npl_id: string
  player_name: string | null
  status: string
  table_number: number | null
  seat_number: number | null
  buy_in: CashierCell
  rebuy: CashierCell
  addon: CashierCell
  jackpot: CashierCell
  paid_cents: number
}

export type CashierReport = {
  session: {
    id: number
    name: string
    venue_name: string | null
    game_type: 'tournament' | 'cash'
    status: string
    created_at: string | null
  }
  players: CashierPlayerRow[]
  totals: {
    buy_in: CashierCell
    rebuy: CashierCell
    addon: CashierCell
    jackpot: CashierCell
    gross_cents: number
  }
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string } }
    | null

  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error?.message || body?.message || "The cashier feed failed.")
  }

  return (body?.data ?? body) as T
}

export const cashierApi = {
  sessions: () => request<{ sessions: CashierSession[] }>('/api/v1/desk/cashier/sessions'),
  report: (sessionId: number) => request<CashierReport>(`/api/v1/desk/${sessionId}/cashier`),
}
