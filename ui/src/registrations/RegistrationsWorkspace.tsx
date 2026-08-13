import { useEffect, useMemo, useRef, useState } from "react"
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
  // The date filter defaults to today once per venue load — a live refresh
  // must never snap it back while staff are reading another day.
  const defaultedDateRef = useRef(false)

  useEffect(() => {
    setSessions(null)
    defaultedDateRef.current = false
    let cancelled = false

    const load = (initial: boolean) => {
      deskApi.allSessions(venueId)
        .then((result) => {
          if (cancelled) return
          setSessions(result.sessions)
          setError(null)
        })
        .catch((e) => {
          // A failed background refresh keeps the last good grid; only the
          // first load has nothing to fall back on.
          if (!cancelled && initial) setError(e instanceof Error ? e.message : "Sessions could not be loaded.")
        })
    }

    load(true)

    // The backend link fires this after every pulled change — an online
    // registration reaches the grid the moment the cloud signals it,
    // without anyone switching tabs or reopening the workspace.
    const onSessionsUpdated = () => load(false)
    window.addEventListener("npl:sessions-updated", onSessionsUpdated)

    return () => {
      cancelled = true
      window.removeEventListener("npl:sessions-updated", onSessionsUpdated)
    }
  }, [venueId])

  // Only dates that actually hold a session are offered as filters.
  const dates = useMemo(() => {
    const unique = [...new Set((sessions ?? []).map((session) => session.session_date))]
    unique.sort()
    return unique
  }, [sessions])

  useEffect(() => {
    // Default to today when today has sessions; otherwise show everything.
    if (sessions === null || defaultedDateRef.current) return
    defaultedDateRef.current = true
    const today = new Date().toISOString().slice(0, 10)
    if (dates.includes(today)) setDate(today)
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
  // One in-flight action at a time; a confirm step guards both actions.
  const [busyNpl, setBusyNpl] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{ action: "promote" | "remove", row: OnlineRegistration } | null>(null)
  // Monotonic fetch guard: live refreshes overlap the initial and
  // post-action loads, and a slow older response must never overwrite a
  // newer table.
  const seqRef = useRef(0)
  const busyRef = useRef<string | null>(null)
  busyRef.current = busyNpl

  const load = (silent = false) => {
    const seq = ++seqRef.current
    deskApi.onlineRegistrations(session.session_id)
      .then((result) => {
        if (seq === seqRef.current) setRows(result)
      })
      .catch((e) => {
        // A silent (signal-driven) refresh keeps the last good table
        // rather than flashing an error the operator did nothing to cause.
        if (seq === seqRef.current && !silent) {
          setError(e instanceof Error ? e.message : "The registration record could not be loaded.")
        }
      })
  }

  useEffect(() => {
    load()

    // The backend link fires this after every pulled change — the open
    // record re-reads the cloud so a phone registration lands in the table
    // without closing the popup. Skipped mid-action; the action reloads on
    // completion anyway.
    const onSessionsUpdated = () => {
      if (busyRef.current === null) load(true)
    }
    window.addEventListener("npl:sessions-updated", onSessionsUpdated)

    return () => {
      seqRef.current += 1
      window.removeEventListener("npl:sessions-updated", onSessionsUpdated)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.session_id])

  async function runAction(action: "promote" | "remove", row: OnlineRegistration) {
    setBusyNpl(row.npl_id)
    setError(null)
    try {
      if (action === "promote") {
        await deskApi.promoteCloudRegistration(session.session_id, row.npl_id)
      } else {
        await deskApi.removeCloudRegistration(session.session_id, row.npl_id)
      }
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : "The change could not be applied.")
    } finally {
      setBusyNpl(null)
      setConfirm(null)
    }
  }

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
                <tr><th>#</th><th>Name</th><th>NPL ID</th><th>Status</th><th>Registered</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.npl_id}>
                    <td>{index + 1}</td>
                    <td>
                      {row.pre_registered ? (
                        <span className="regs__pre" title="Pre-registered — seat secured at club check-in">PRE</span>
                      ) : null}
                      {row.covered_by_voucher ? (
                        <span className="regs__voucher" title={`Entry paid online with voucher ${row.covered_by_voucher.code} — do not charge again`}>VOUCHER</span>
                      ) : null}
                      {row.invited_entry ? (
                        <span className="regs__invite" title="Club invitation — seat confirmed by the event's invite list">INVITE</span>
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
                    <td className="regs__rowactions">
                      {row.status === "waitlisted" ? (
                        <button
                          type="button"
                          className="regs__action regs__action--seat"
                          disabled={busyNpl !== null}
                          onClick={() => setConfirm({ action: "promote", row })}
                        >
                          {busyNpl === row.npl_id ? <Loader2 size={12} className="host-spin" /> : null} Seat
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="regs__action regs__action--remove"
                        disabled={busyNpl !== null}
                        onClick={() => setConfirm({ action: "remove", row })}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        {confirm ? (
          <div className="regs__confirm" role="alertdialog" aria-label="Confirm change">
            <p>
              {confirm.action === "promote"
                ? `Seat ${confirm.row.display_name} from the wait list? They get the first free seat and an inbox notice.`
                : `Remove ${confirm.row.display_name}'s online registration? Their wait list moves up and they get an inbox notice.`}
            </p>
            <div className="regs__confirmactions">
              <button type="button" disabled={busyNpl !== null} onClick={() => void runAction(confirm.action, confirm.row)}>
                {confirm.action === "promote" ? "Seat player" : "Remove registration"}
              </button>
              <button type="button" className="regs__ghost" disabled={busyNpl !== null} onClick={() => setConfirm(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
