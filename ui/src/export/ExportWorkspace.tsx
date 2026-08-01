import { useCallback, useEffect, useMemo, useState } from "react"
import { CloudOff, Download, FileSpreadsheet, Loader2, RefreshCw, Users, X } from "lucide-react"
import type { Venue } from "../desk/deskApi"
import {
  downloadCsv,
  exportApi,
  money,
  moneyCell,
  shortStamp,
  type ReportFilters,
  type SessionAttendance,
  type SessionReport,
} from "./exportApi"
import "./export.css"

type DetailState = {
  uid: string
  loading: boolean
  error: string | null
  report: SessionReport | null
  attendance: SessionAttendance[]
}

/**
 * Export — every finished game, summarised from the NPL cloud's book of
 * record. The desk pushes a report the moment a game is finished; this tab
 * reads those reports back over the licensed feed, so the figures survive
 * a reinstall and never depend on this laptop's local database.
 */
export default function ExportWorkspace({ venue }: { venue: Venue | null }) {
  const [filters, setFilters] = useState<ReportFilters>({ from: "", to: "", gameType: "" })
  const [rows, setRows] = useState<SessionReport[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)

  const load = useCallback(async (current: ReportFilters) => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await exportApi.sessions(current)
      setRows(result.data)
    } catch (e) {
      setRows(null)
      setLoadError(e instanceof Error ? e.message : "The reports could not be loaded.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load({ from: "", to: "", gameType: "" })
  }, [load])

  const totals = useMemo(() => {
    if (!rows || rows.length === 0) return null
    return rows.reduce(
      (sum, row) => ({
        entries: sum.entries + row.entries_count,
        players: sum.players + row.unique_players,
        gross: sum.gross + row.gross_cents,
        jackpot: sum.jackpot + row.jackpot_entries_count,
      }),
      { entries: 0, players: 0, gross: 0, jackpot: 0 },
    )
  }, [rows])

  function updateFilter<K extends keyof ReportFilters>(key: K, value: ReportFilters[K]) {
    const next = { ...filters, [key]: value }
    setFilters(next)
    void load(next)
  }

  async function openDetail(uid: string) {
    setDetail({ uid, loading: true, error: null, report: null, attendance: [] })
    try {
      const result = await exportApi.session(uid)
      setDetail({ uid, loading: false, error: null, report: result.report, attendance: result.attendance })
    } catch (e) {
      setDetail({
        uid,
        loading: false,
        error: e instanceof Error ? e.message : "The attendance could not be loaded.",
        report: null,
        attendance: [],
      })
    }
  }

  function exportSummaryCsv() {
    if (!rows || rows.length === 0) return
    downloadCsv(
      `npl-finished-games${filters.from ? `-${filters.from}` : ""}${filters.to ? `-${filters.to}` : ""}.csv`,
      [
        "Finished", "Started", "Name", "Type", "Venue", "Entries", "Unique players",
        "Rebuys", "Add-ons", "Jackpot entries",
        "Buy-in $", "Rebuy $", "Add-on $", "Jackpot $", "Gross $",
      ],
      rows.map((row) => [
        shortStamp(row.finished_at),
        shortStamp(row.started_at),
        row.name,
        row.game_type === "cash" ? "Cash game" : "Tournament",
        row.venue_name ?? "",
        String(row.entries_count),
        String(row.unique_players),
        String(row.rebuys_count),
        String(row.addons_count),
        String(row.jackpot_entries_count),
        moneyCell(row.buyin_cents),
        moneyCell(row.rebuy_cents),
        moneyCell(row.addon_cents),
        moneyCell(row.jackpot_cents),
        moneyCell(row.gross_cents),
      ]),
    )
  }

  function exportAttendanceCsv(current: DetailState) {
    if (!current.report || current.attendance.length === 0) return
    downloadCsv(
      `npl-attendance-${current.report.tournament_uid.slice(0, 12)}.csv`,
      ["NPL ID", "Player", "Buy-ins", "Rebuys", "Add-ons", "Jackpot", "Paid $"],
      current.attendance.map((entry) => [
        entry.npl_id,
        entry.display_name ?? "",
        String(entry.buy_ins),
        String(entry.rebuys),
        String(entry.addons),
        entry.in_jackpot ? "Yes" : "No",
        moneyCell(entry.paid_cents),
      ]),
    )
  }

  return (
    <div className="exports">
      <header className="exports__head">
        <div>
          <h3><FileSpreadsheet size={18} /> Export — finished games</h3>
          <p>
            Every finished tournament and cash game, read from the NPL cloud's book of record —
            not this laptop's local database. Pick a range, open a row for the player attendance,
            and download either as CSV.
          </p>
        </div>
        <button
          type="button"
          className="exports__download"
          disabled={!rows || rows.length === 0}
          onClick={exportSummaryCsv}
        >
          <Download size={15} /> Download CSV
        </button>
      </header>

      <div className="exports__filters">
        <label>
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            onChange={(event) => updateFilter("from", event.target.value)}
          />
        </label>
        <label>
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            onChange={(event) => updateFilter("to", event.target.value)}
          />
        </label>
        <label>
          <span>Game type</span>
          <select
            value={filters.gameType}
            onChange={(event) => updateFilter("gameType", event.target.value as ReportFilters["gameType"])}
          >
            <option value="">All games</option>
            <option value="tournament">Tournaments</option>
            <option value="cash">Cash games</option>
          </select>
        </label>
        <button type="button" className="exports__refresh" disabled={loading} onClick={() => void load(filters)}>
          {loading ? <Loader2 size={14} className="exports__spin" /> : <RefreshCw size={14} />} Refresh
        </button>
        {venue ? <span className="exports__venue">Licence scope: {venue.name}</span> : null}
      </div>

      {loadError ? (
        <p className="exports__offline"><CloudOff size={15} /> {loadError}</p>
      ) : null}

      {totals ? (
        <div className="exports__totals">
          <div><span>Finished games</span><strong>{rows?.length.toLocaleString()}</strong></div>
          <div><span>Total entries</span><strong>{totals.entries.toLocaleString()}</strong></div>
          <div><span>Players (per-game unique)</span><strong>{totals.players.toLocaleString()}</strong></div>
          <div><span>Jackpot entries</span><strong>{totals.jackpot.toLocaleString()}</strong></div>
          <div className="exports__totals-gross"><span>Gross collected</span><strong>{money(totals.gross)}</strong></div>
        </div>
      ) : null}

      <div className="exports__tablewrap">
        {rows === null && !loadError ? (
          <p className="exports__empty"><Loader2 size={15} className="exports__spin" /> Loading reports from the cloud…</p>
        ) : rows !== null && rows.length === 0 ? (
          <p className="exports__empty">
            No finished games in this range yet — reports appear the moment a game is finished at the desk.
          </p>
        ) : rows !== null ? (
          <table className="exports__table">
            <thead>
              <tr>
                <th>Finished</th>
                <th>Name</th>
                <th>Type</th>
                <th>Venue</th>
                <th className="num">Entries</th>
                <th className="num">Players</th>
                <th className="num">Rebuys</th>
                <th className="num">Add-ons</th>
                <th className="num">Jackpot</th>
                <th className="num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.tournament_uid}
                  className={detail?.uid === row.tournament_uid ? "is-open" : undefined}
                  onClick={() => void openDetail(row.tournament_uid)}
                >
                  <td>{shortStamp(row.finished_at)}</td>
                  <td className="exports__name">{row.name}</td>
                  <td>
                    <span className={`exports__chip exports__chip--${row.game_type}`}>
                      {row.game_type === "cash" ? "Cash" : "Tournament"}
                    </span>
                  </td>
                  <td>{row.venue_name ?? "—"}</td>
                  <td className="num">{row.entries_count.toLocaleString()}</td>
                  <td className="num">{row.unique_players.toLocaleString()}</td>
                  <td className="num">{row.rebuys_count.toLocaleString()}</td>
                  <td className="num">{row.addons_count.toLocaleString()}</td>
                  <td className="num">{row.jackpot_entries_count.toLocaleString()}</td>
                  <td className="num exports__gross">{money(row.gross_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {detail ? (
        <section className="exports__detail" aria-label="Session attendance">
          <header>
            <div>
              <h4><Users size={16} /> {detail.report?.name ?? "Session"} — attendance</h4>
              {detail.report ? (
                <p>
                  {shortStamp(detail.report.finished_at)}
                  {detail.report.venue_name ? ` · ${detail.report.venue_name}` : ""}
                  {` · ${detail.report.unique_players.toLocaleString()} players · ${money(detail.report.gross_cents)} gross`}
                </p>
              ) : null}
            </div>
            <div className="exports__detail-actions">
              <button
                type="button"
                className="exports__download exports__download--ghost"
                disabled={detail.attendance.length === 0}
                onClick={() => exportAttendanceCsv(detail)}
              >
                <Download size={14} /> Attendance CSV
              </button>
              <button type="button" className="exports__close" aria-label="Close attendance" onClick={() => setDetail(null)}>
                <X size={16} />
              </button>
            </div>
          </header>

          {detail.loading ? (
            <p className="exports__empty"><Loader2 size={15} className="exports__spin" /> Loading attendance…</p>
          ) : detail.error ? (
            <p className="exports__offline"><CloudOff size={15} /> {detail.error}</p>
          ) : detail.attendance.length === 0 ? (
            <p className="exports__empty">No attendance rows were recorded for this session.</p>
          ) : (
            <div className="exports__tablewrap exports__tablewrap--detail">
              <table className="exports__table">
                <thead>
                  <tr>
                    <th>NPL ID</th>
                    <th>Player</th>
                    <th className="num">Buy-ins</th>
                    <th className="num">Rebuys</th>
                    <th className="num">Add-ons</th>
                    <th>Jackpot</th>
                    <th className="num">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.attendance.map((entry) => (
                    <tr key={entry.npl_id}>
                      <td className="exports__npl">{entry.npl_id}</td>
                      <td>{entry.display_name ?? "—"}</td>
                      <td className="num">{entry.buy_ins}</td>
                      <td className="num">{entry.rebuys}</td>
                      <td className="num">{entry.addons}</td>
                      <td>{entry.in_jackpot ? <span className="exports__chip exports__chip--jackpot">In</span> : "—"}</td>
                      <td className="num exports__gross">{money(entry.paid_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  )
}
