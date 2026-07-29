import { useCallback, useEffect, useState } from "react"
import { CalendarDays, ChevronDown, Loader2, Play, Table2, Trash2, Users, X } from "lucide-react"
import { deskApi, type RosterTable, type UpcomingSession, type Venue } from "./deskApi"
import { notify } from "../notifications/store"
import "./host.css"

type Props = {
  venue: Venue | null
  onOpenLocal: (localTournamentId: number) => void
  onPrepare: (gameSessionId: number | null) => void
}

/**
 * The Tournament tab's front door: every current cloud session for the
 * picked venue, with the live numbers that matter — online registrations
 * and table count — kept fresh by the realtime gateway. From here the desk
 * holds full authority over a session (cancel tables, remove players,
 * open the desk) — everything except deleting the session itself, which
 * belongs to the cloud.
 */
export default function SessionsHub({ venue, onOpenLocal, onPrepare }: Props) {
  const [sessions, setSessions] = useState<UpcomingSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [roster, setRoster] = useState<RosterTable[] | null>(null)
  const [rosterLoading, setRosterLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmAction, setConfirmAction] = useState<{ label: string, run: () => Promise<void> } | null>(null)

  const load = useCallback(async (initial = false) => {
    if (!venue) {
      setSessions([])
      setLoading(false)
      return
    }

    if (initial) setLoading(true)
    try {
      const result = await deskApi.upcomingSessions(venue.id)
      setSessions(result.sessions.filter((session) => session.category !== "cash_game"))
      setError(null)
    } catch (e) {
      if (initial) setError(e instanceof Error ? e.message : "Sessions could not be loaded.")
    } finally {
      if (initial) setLoading(false)
    }
  }, [venue])

  const loadRoster = useCallback(async (gameSessionId: number) => {
    setRosterLoading(true)
    try {
      const result = await deskApi.sessionRoster(gameSessionId)
      setRoster(result.tables)
    } catch {
      setRoster([])
    } finally {
      setRosterLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(true)

    // The realtime gateway announces every change; re-read on each signal
    // plus a slow safety interval.
    const onUpdate = () => {
      void load(false)
      if (expanded !== null) void loadRoster(expanded)
    }
    window.addEventListener("npl:sessions-updated", onUpdate)
    const timer = window.setInterval(onUpdate, 15_000)

    return () => {
      window.removeEventListener("npl:sessions-updated", onUpdate)
      window.clearInterval(timer)
    }
  }, [load, loadRoster, expanded])

  function toggleExpand(session: UpcomingSession) {
    if (expanded === session.session_id) {
      setExpanded(null)
      setRoster(null)
      return
    }

    setExpanded(session.session_id)
    setRoster(null)
    void loadRoster(session.session_id)
  }

  async function guarded(label: string, run: () => Promise<void>) {
    setConfirmAction({ label, run })
  }

  async function runConfirmed() {
    if (!confirmAction) return
    setBusy(true)
    try {
      await confirmAction.run()
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change could not be applied.")
    } finally {
      setBusy(false)
      setConfirmAction(null)
    }
  }

  if (!venue) {
    return <p className="host-hub__empty">Pick a venue in the header to see its sessions.</p>
  }

  return (
    <div className="host-hub">
      <header className="host-hub__head">
        <div>
          <h3><CalendarDays size={18} /> Sessions — {venue.name}</h3>
          <p>Live from the NPL cloud. Open the desk on tonight's game, or run a local-only tournament.</p>
        </div>
        <button type="button" className="host-desk__exit" onClick={() => onPrepare(null)}>
          Local-only game
        </button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}

      {loading ? (
        <p className="host-hub__empty"><Loader2 size={16} className="host-spin" /> Loading sessions…</p>
      ) : sessions.length === 0 ? (
        <p className="host-hub__empty">No scheduled sessions in the sync window for this venue.</p>
      ) : (
        <div className="host-hub__list">
          {sessions.map((session) => {
            const isOpen = expanded === session.session_id
            const finished = session.local_tournament_status === "finished"
            return (
              <article key={session.session_id} className="host-hub__card">
                <div className="host-hub__row">
                  <div className="host-hub__when">
                    <strong>{session.session_date ?? "—"}</strong>
                    <small>{session.start_time ? session.start_time.slice(0, 5) : ""}</small>
                  </div>

                  <div className="host-hub__title">
                    <strong>{session.title ?? `Session #${session.session_id}`}</strong>
                    <small>
                      {session.source_type === "championship" ? "Championship" : "Tournament"}
                      {finished ? " · finished" : session.local_tournament_id ? " · desk open" : ""}
                    </small>
                  </div>

                  <div className="host-hub__stat" title="Online registrations">
                    <Users size={15} />
                    <strong>{session.registrations_count}</strong>
                    <small>online</small>
                  </div>

                  <div className="host-hub__stat" title="Tables">
                    <Table2 size={15} />
                    <strong>{session.tables_count}</strong>
                    <small>tables</small>
                  </div>

                  <button
                    type="button"
                    className="host-hub__expand"
                    aria-expanded={isOpen}
                    onClick={() => toggleExpand(session)}
                  >
                    <ChevronDown size={16} style={{ transform: isOpen ? "rotate(180deg)" : undefined }} />
                  </button>

                  {finished ? (
                    <span className="host-hub__done">Finished</span>
                  ) : session.local_tournament_id !== null ? (
                    <button
                      type="button"
                      className="host-hub__open"
                      onClick={() => onOpenLocal(session.local_tournament_id!)}
                    >
                      <Play size={14} /> Resume desk
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="host-hub__open"
                      onClick={() => onPrepare(session.session_id)}
                    >
                      <Play size={14} /> Prepare &amp; open
                    </button>
                  )}
                </div>

                {isOpen ? (
                  <div className="host-hub__roster">
                    {rosterLoading ? (
                      <p className="host-hub__empty"><Loader2 size={14} className="host-spin" /> Loading roster…</p>
                    ) : !roster || roster.length === 0 ? (
                      <p className="host-hub__empty">No tables yet — they appear as bookings and buy-ins come in.</p>
                    ) : (
                      roster.map((table) => (
                        <div key={table.table_number} className="host-hub__table">
                          <header>
                            <strong>Table {table.table_number}</strong>
                            <span>{table.players.filter((p) => p.status !== "waitlisted").length} / {table.max_seats}</span>
                            <button
                              type="button"
                              title="Cancel this table — seated players are notified"
                              disabled={busy}
                              onClick={() => void guarded(
                                `Cancel table ${table.table_number}? Seated players are notified and wait-lists resolve.`,
                                async () => {
                                  await deskApi.cancelCloudTable(session.session_id, table.table_number)
                                  notify("system", `Table ${table.table_number} cancelled`, `Session #${session.session_id}.`, "warning")
                                  await load(false)
                                  await loadRoster(session.session_id)
                                },
                              )}
                            >
                              <Trash2 size={14} />
                            </button>
                          </header>
                          <ul>
                            {table.players.map((player) => (
                              <li key={player.npl_id}>
                                <span>
                                  {player.status === "waitlisted"
                                    ? `WL${player.waitlist_position ?? ""}`
                                    : player.seat_number !== null ? `S${player.seat_number}` : "—"}
                                </span>
                                <strong>{player.display_name ?? player.npl_id}</strong>
                                <button
                                  type="button"
                                  title="Remove this registration"
                                  disabled={busy}
                                  onClick={() => void guarded(
                                    `Remove ${player.display_name ?? player.npl_id} from this session?`,
                                    async () => {
                                      await deskApi.removeCloudRegistration(session.session_id, player.npl_id)
                                      notify("registration", `${player.display_name ?? player.npl_id} removed`, `Session #${session.session_id} — desk removal.`, "warning")
                                      await load(false)
                                      await loadRoster(session.session_id)
                                    },
                                  )}
                                >
                                  <X size={13} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))
                    )}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}

      {confirmAction ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => { if (!busy) setConfirmAction(null) }}>
          <section className="host-scan-modal__panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <p className="host-hub__confirm">{confirmAction.label}</p>
            <footer className="host-scan-modal__footer">
              <span className="host-scan-modal__total" />
              <button type="button" className="host-scan-modal__cancel" disabled={busy} onClick={() => setConfirmAction(null)}>
                Cancel
              </button>
              <button type="button" className="host-scan-modal__submit" disabled={busy} onClick={() => void runConfirmed()}>
                {busy ? "Applying…" : "Confirm"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}
