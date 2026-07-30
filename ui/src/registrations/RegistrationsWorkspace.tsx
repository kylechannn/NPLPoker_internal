import { useEffect, useMemo, useState } from "react"
import { CalendarDays, ListChecks, Loader2, Users, X } from "lucide-react"
import { deskApi, type OnlineRegistration, type SessionSummary, type Venue } from "../desk/deskApi"
import "./registrations.css"

/**
 * Registrations: the whole online record, gathered by session. Pick a date
 * (only dates that actually have sessions are offered), press a session,
 * and the popup lists who registered online — name, NPL ID and when.
 */
export default function RegistrationsWorkspace({ venue }: { venue: Venue | null }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [date, setDate] = useState<string | "all">("all")
  const [open, setOpen] = useState<SessionSummary | null>(null)

  const venueId = venue?.id ?? null

  useEffect(() => {
    setSessions(null)
    deskApi.allSessions(venueId)
      .then((result) => setSessions(result.sessions))
      .catch((e) => setError(e instanceof Error ? e.message : "Sessions could not be loaded."))
  }, [venueId])

  // Only dates that actually hold a session are offered as filters.
  const dates = useMemo(() => {
    const unique = [...new Set((sessions ?? []).map((session) => session.session_date))]
    unique.sort()
    return unique
  }, [sessions])

  useEffect(() => {
    // Default to today when today has sessions; otherwise show everything.
    const today = new Date().toISOString().slice(0, 10)
    if (sessions !== null && dates.includes(today)) setDate(today)
  }, [sessions, dates])

  const shown = useMemo(
    () => (sessions ?? []).filter((session) => date === "all" || session.session_date === date),
    [sessions, date],
  )

  return (
    <div className="regs">
      <header className="regs__head">
        <div>
          <h3><ListChecks size={18} /> Registrations{venue ? ` — ${venue.name}` : ""}</h3>
          <p>The online registration record, gathered by session. Press a session to see who registered and when.</p>
        </div>
      </header>

      {error ? <p className="players__error" role="alert">{error}</p> : null}

      {sessions === null && !error ? (
        <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading sessions…</p>
      ) : (
        <>
          <div className="regs__dates" role="tablist" aria-label="Filter by date">
            <button
              type="button"
              role="tab"
              aria-selected={date === "all"}
              className={date === "all" ? "regs__date regs__date--active" : "regs__date"}
              onClick={() => setDate("all")}
            >
              All dates
            </button>
            {dates.map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={date === value}
                className={date === value ? "regs__date regs__date--active" : "regs__date"}
                onClick={() => setDate(value)}
              >
                <CalendarDays size={13} />
                {new Date(`${value}T00:00:00`).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="players__empty">No sessions on this date.</p>
          ) : (
            <div className="regs__list">
              {shown.map((session) => (
                <button key={session.session_id} type="button" className="regs__card" onClick={() => setOpen(session)}>
                  <div className="regs__cardmain">
                    <strong>{session.title ?? `Session #${session.session_id}`}</strong>
                    <small>
                      {new Date(`${session.session_date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}
                      {session.start_time ? ` · ${session.start_time.slice(0, 5)}` : ""}
                      {session.venue_name ? ` · ${session.venue_name}` : ""}
                    </small>
                  </div>
                  <span className={`regs__status regs__status--${session.status}`}>{session.status}</span>
                  <span className="regs__count">
                    <Users size={13} />
                    {session.registrations_count}
                    {session.max_players ? ` / ${session.max_players}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {open ? <RegistrationsModal session={open} onClose={() => setOpen(null)} /> : null}
    </div>
  )
}

function RegistrationsModal({ session, onClose }: { session: SessionSummary, onClose: () => void }) {
  const [rows, setRows] = useState<OnlineRegistration[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    deskApi.onlineRegistrations(session.session_id)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : "The registration record could not be loaded."))
  }, [session.session_id])

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Online registrations — ${session.title ?? session.session_id}`}>
      <div className="membership-modal__card membership-modal__card--wide players__commentsmodal">
        <div className="regs__modalhead">
          <div>
            <h4>{session.title ?? `Session #${session.session_id}`}</h4>
            <small>
              {new Date(`${session.session_date}T00:00:00`).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}
              {session.start_time ? ` · ${session.start_time.slice(0, 5)}` : ""}
              {session.venue_name ? ` · ${session.venue_name}` : ""}
            </small>
          </div>
          <button type="button" className="regs__close" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        {error ? <p className="players__error" role="alert">{error}</p> : null}

        <div className="players__commentsscroll">
          {rows === null && !error ? (
            <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading the record…</p>
          ) : rows !== null && rows.length === 0 ? (
            <p className="players__empty">No online registrations for this session.</p>
          ) : rows !== null ? (
            <table className="regs__table">
              <thead>
                <tr><th>#</th><th>Name</th><th>NPL ID</th><th>Status</th><th>Registered</th></tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.npl_id}>
                    <td>{index + 1}</td>
                    <td>
                      {row.pre_registered ? (
                        <span className="regs__pre" title="Pre-registered — seat secured at club check-in">PRE</span>
                      ) : null}
                      {row.display_name}
                    </td>
                    <td><code>{row.npl_id}</code></td>
                    <td>
                      {row.status === "waitlisted"
                        ? `Waitlist${row.waitlist_position !== null ? ` #${row.waitlist_position}` : ""}`
                        : row.table_number !== null && row.seat_number !== null
                          ? `T${row.table_number} S${row.seat_number}`
                          : "Registered"}
                    </td>
                    <td>
                      {row.registered_at
                        ? new Date(row.registered_at).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
