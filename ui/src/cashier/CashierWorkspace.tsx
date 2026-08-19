import { useCallback, useEffect, useMemo, useState } from "react"
import { Banknote, Check, RefreshCw } from "lucide-react"
import { cashierApi, type CashierCell, type CashierReport, type CashierSession } from "./cashierApi"
import { money } from "../export/exportApi"
import "./cashier.css"

/**
 * The cashier's ledger view: every player in the session as a row, every
 * money action as a column — a tick the moment it is recorded — and the
 * till totals at the bottom. Reads the LOCAL ledger only, so it works
 * with no internet; the same events ride the money queue to the cloud.
 */
export default function CashierWorkspace() {
  const [sessions, setSessions] = useState<CashierSession[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [report, setReport] = useState<CashierReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    cashierApi.sessions()
      .then(({ sessions }) => {
        if (cancelled) return
        setSessions(sessions)
        setSelectedId((current) => current ?? sessions[0]?.id ?? null)
        if (sessions.length === 0) setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : "The session list failed to load.")
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const loadReport = useCallback((sessionId: number, background = false) => {
    if (!background) setLoading(true)
    cashierApi.report(sessionId)
      .then((data) => {
        setReport(data)
        setError(null)
      })
      .catch((e) => {
        if (!background) setError(e instanceof Error ? e.message : "The cashier report failed to load.")
      })
      .finally(() => { if (!background) setLoading(false) })
  }, [])

  useEffect(() => {
    if (selectedId === null) return
    loadReport(selectedId)
    // Live ticks: actions land from the desk or the admin phone while
    // this tab is open — refresh quietly while visible.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadReport(selectedId, true)
    }, 10000)
    return () => window.clearInterval(timer)
  }, [selectedId, loadReport])

  const totals = report?.totals ?? null
  const players = report?.players ?? []
  const playerCount = players.length
  const paidPlayers = useMemo(() => players.filter((p) => p.paid_cents > 0).length, [players])

  return (
    <div className="cashier">
      <header className="cashier__head">
        <div>
          <h2><Banknote size={18} /> Cashier</h2>
          <p>Every buy-in, rebuy, add-on and jackpot in the till — recorded here first, then queued to the NPL cloud.</p>
        </div>
        <div className="cashier__controls">
          <select
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(Number(event.target.value) || null)}
            aria-label="Session"
          >
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} — {session.venue_name ?? "No venue"} ({session.status})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => { if (selectedId !== null) loadReport(selectedId) }}
            disabled={selectedId === null || loading}
            title="Refresh"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </header>

      {error ? <p className="cashier__error" role="alert">{error}</p> : null}

      {loading ? (
        <p className="cashier__empty">Loading the till…</p>
      ) : sessions.length === 0 ? (
        <p className="cashier__empty">No sessions yet — the ledger starts with the first buy-in.</p>
      ) : report === null ? null : (
        <>
          <div className="cashier__tablewrap">
            <table className="cashier__table">
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">Status</th>
                  <th scope="col">Buy-in</th>
                  <th scope="col">Rebuy</th>
                  <th scope="col">Add-on</th>
                  <th scope="col">Jackpot</th>
                  <th scope="col" className="cashier__num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player) => (
                  <tr key={player.npl_id} className={player.status === "removed" || player.status === "auto_removed" ? "cashier__row--removed" : undefined}>
                    <td>
                      <strong>{player.player_name ?? player.npl_id}</strong>
                      <small>{player.npl_id}{player.table_number !== null ? ` · T${player.table_number}S${player.seat_number ?? "?"}` : ""}</small>
                    </td>
                    <td><span className={`cashier__status cashier__status--${player.status}`}>{player.status.replace("_", " ")}</span></td>
                    {(["buy_in", "rebuy", "addon", "jackpot"] as const).map((kind) => (
                      <td key={kind} className="cashier__cell">
                        {player[kind].count > 0 ? (
                          <span className="cashier__tick">
                            <Check size={13} />
                            {player[kind].count > 1 ? ` ×${player[kind].count}` : ""}
                            <em>{money(player[kind].cents)}</em>
                          </span>
                        ) : (
                          <span className="cashier__dash">—</span>
                        )}
                      </td>
                    ))}
                    <td className="cashier__num"><strong>{money(player.paid_cents)}</strong></td>
                  </tr>
                ))}
              </tbody>
              {totals ? (
                <tfoot>
                  <tr>
                    <td><strong>{playerCount} players</strong><small>{paidPlayers} paid</small></td>
                    <td />
                    {(["buy_in", "rebuy", "addon", "jackpot"] as const).map((kind) => (
                      <td key={kind} className="cashier__cell">
                        <span className="cashier__totalcell">
                          {totals[kind].count > 0 ? `×${totals[kind].count}` : "—"}
                          <em>{money(totals[kind].cents)}</em>
                        </span>
                      </td>
                    ))}
                    <td className="cashier__num"><strong>{money(totals.gross_cents)}</strong></td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>

          {totals ? (
            <section className="cashier__summary" aria-label="Session totals">
              <div><span>Buy-ins</span><strong>{money(totals.buy_in.cents)}</strong></div>
              <div><span>Rebuys</span><strong>{money(totals.rebuy.cents)}</strong></div>
              <div><span>Add-ons</span><strong>{money(totals.addon.cents)}</strong></div>
              <div><span>Jackpot</span><strong>{money(totals.jackpot.cents)}</strong></div>
              <div className="cashier__summary-total"><span>Total received</span><strong>{money(totals.gross_cents)}</strong></div>
            </section>
          ) : null}
        </>
      )}
    </div>
  )
}
