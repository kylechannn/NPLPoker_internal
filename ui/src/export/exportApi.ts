/**
 * The Export tab's data — finished-game reports read back FROM THE CLOUD
 * (the book of record), never the local database. The local host merely
 * proxies the licensed feed, so a reinstalled laptop exports the same
 * history as the one that ran the games.
 */

export type SessionReport = {
  tournament_uid: string
  game_session_id: number | null
  venue_id: number | null
  venue_name: string | null
  game_type: "tournament" | "cash"
  name: string
  started_at: string | null
  finished_at: string | null
  entries_count: number
  unique_players: number
  rebuys_count: number
  addons_count: number
  jackpot_entries_count: number
  buyin_cents: number
  rebuy_cents: number
  addon_cents: number
  jackpot_cents: number
  gross_cents: number
}

export type SessionAttendance = {
  npl_id: string
  display_name: string | null
  buy_ins: number
  rebuys: number
  addons: number
  in_jackpot: boolean
  paid_cents: number
}

export type ReportFilters = {
  from: string
  to: string
  gameType: "" | "tournament" | "cash"
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string } }
    | null

  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error?.message || body?.message || "The reports feed failed.")
  }

  return (body?.data ?? body) as T
}

export const exportApi = {
  sessions: (filters: ReportFilters) => {
    const params = new URLSearchParams()
    if (filters.from) params.set("from", filters.from)
    if (filters.to) params.set("to", filters.to)
    if (filters.gameType) params.set("game_type", filters.gameType)
    const query = params.toString()
    return request<{ data: SessionReport[] }>(`/api/v1/reports/sessions${query ? `?${query}` : ""}`)
  },

  session: (uid: string) =>
    request<{ report: SessionReport | null, attendance: SessionAttendance[] }>(
      `/api/v1/reports/sessions/${encodeURIComponent(uid)}`,
    ),
}

/** Dollars for the screen: whole when clean, cents when they exist. */
export function money(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** Dollars for a spreadsheet cell: a plain decimal, no symbol. */
export function moneyCell(cents: number): string {
  return (cents / 100).toFixed(2)
}

/** "2026-08-01 19:30:00" (venue-local, as recorded) → "2026-08-01 19:30". */
export function shortStamp(value: string | null): string {
  if (!value) return "—"
  return value.replace("T", " ").slice(0, 16)
}

/** RFC-4180 CSV with a BOM so Excel opens it as UTF-8 without asking. */
export function downloadCsv(filename: string, header: string[], rows: string[][]): void {
  const escape = (cell: string) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)
  const lines = [header, ...rows].map((row) => row.map(escape).join(","))
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
