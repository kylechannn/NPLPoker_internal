import { useEffect, useMemo, useState } from "react"
import { countdown, deskApi, type Gates, type Seating } from "./deskApi"
import "./timer.css"

type ClockState = {
  name: string
  venue_name: string | null
  status: string
  running: boolean
  level_index: number
  level_count: number
  current_level: {
    level_no: number
    is_break: boolean
    small_blind: number
    big_blind: number
    ante: number
    bb_ante: number
    label: string
    note: string | null
  } | null
  next_level: ClockState["current_level"]
  remaining_ms: number
  level_duration_ms: number
}

type Summary = {
  total_players?: number
  active_players?: number
  average_stack?: number
}

const SYNC_MS = 5000
const TICK_MS = 250

/**
 * The room display: the clock as everyone at the tables reads it.
 *
 * Opened as its own window so it can live on a projector or a second screen
 * while the desk keeps working. EdgeHost ran this as a browser-side timer,
 * which meant two open windows drifted apart and a reload restarted the
 * tournament at level one. Here the clock is server-authoritative — every
 * window derives the same countdown from the same timestamps, so opening a
 * second display is free and a reload changes nothing.
 */
export default function TimerDisplay({ sessionId }: { sessionId: number }) {
  const [clock, setClock] = useState<ClockState | null>(null)
  const [summary, setSummary] = useState<Summary>({})
  const [gates, setGates] = useState<Gates | null>(null)
  const [syncedAt, setSyncedAt] = useState(0)
  const [now, setNow] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    // One call carries the clock, the gates and the counts — the display
    // has no reason to make three round trips for one screen.
    async function pull() {
      try {
        const seating: Seating = await deskApi.seating(sessionId)

        if (cancelled) return

        setError(null)
        setClock(seating.clock as unknown as ClockState)
        setSummary({
          total_players: seating.counts.total_players ?? seating.counts.entries,
          active_players: seating.counts.active_players ?? seating.counts.active,
          average_stack: seating.counts.average_stack,
        })
        setGates(seating.gates)
        setSyncedAt(Date.now())
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Lost contact with the desk.")
      }
    }

    void pull()
    const handle = window.setInterval(() => void pull(), SYNC_MS)

    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
  }, [sessionId])

  // Ticks locally between syncs so the seconds move smoothly; every sync
  // re-bases against the server, so drift never accumulates.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(handle)
  }, [])

  const elapsed = now > syncedAt && syncedAt > 0 ? now - syncedAt : 0
  const remaining = clock
    ? (clock.running ? Math.max(0, clock.remaining_ms - elapsed) : clock.remaining_ms)
    : 0

  const urgent = clock?.running === true && remaining <= 60_000
  const level = clock?.current_level ?? null

  const progress = useMemo(() => {
    if (!clock || clock.level_duration_ms <= 0) return 0
    return Math.min(100, Math.max(0, (1 - remaining / clock.level_duration_ms) * 100))
  }, [clock, remaining])

  if (error && !clock) {
    return (
      <div className="timer timer--error">
        <p>{error}</p>
      </div>
    )
  }

  return (
    <div className={`timer${clock?.status === "paused" ? " timer--paused" : ""}`}>
      <header className="timer__head">
        <div>
          <h1>{clock?.name ?? "Tournament"}</h1>
          {clock?.venue_name ? <p>{clock.venue_name}</p> : null}
        </div>
        <span className="timer__level">
          {level?.is_break
            ? "Break"
            : `Level ${level?.level_no ?? "—"}`}
          <em>of {clock?.level_count ?? "—"}</em>
        </span>
      </header>

      <div className="timer__clock">
        <span className={`timer__count${urgent ? " timer__count--urgent" : ""}`}>
          {clock?.status === "paused" ? "PAUSED" : countdown(remaining)}
        </span>
        <div className="timer__progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="timer__blinds">
        {level?.is_break ? (
          <strong className="timer__break">{level.note || "Break"}</strong>
        ) : (
          <>
            <strong>
              {(level?.small_blind ?? 0).toLocaleString()} / {(level?.big_blind ?? 0).toLocaleString()}
            </strong>
            {level && level.bb_ante > 0 ? <span>ante {level.bb_ante.toLocaleString()}</span> : null}
          </>
        )}
      </div>

      <footer className="timer__foot">
        <div className="timer__next">
          <small>Next</small>
          {clock?.next_level
            ? (clock.next_level.is_break
                ? (clock.next_level.note || "Break")
                : `${clock.next_level.small_blind.toLocaleString()} / ${clock.next_level.big_blind.toLocaleString()}`)
            : "Final level"}
        </div>

        <div className="timer__stat">
          <small>Players</small>
          {summary.active_players ?? "—"}
          {summary.total_players ? <em>/ {summary.total_players}</em> : null}
        </div>

        <div className="timer__stat">
          <small>Avg stack</small>
          {summary.average_stack ? summary.average_stack.toLocaleString() : "—"}
        </div>

        {gates?.registration.open && gates.registration.closes_in_ms !== null ? (
          <div className="timer__stat timer__stat--gate">
            <small>Reg closes</small>
            {countdown(Math.max(0, gates.registration.closes_in_ms - elapsed))}
          </div>
        ) : gates && !gates.registration.open ? (
          <div className="timer__stat timer__stat--shut">
            <small>Registration</small>
            Closed
          </div>
        ) : null}
      </footer>

      {error ? <p className="timer__stale">{error}</p> : null}
    </div>
  )
}
