import { useEffect, useState } from "react"
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, X } from "lucide-react"
import TimerDisplay from "./TimerDisplay"
import { deskApi } from "./deskApi"
import { notify } from "../notifications/store"
import "./timer.css"

type ClockLike = {
  status?: string
  running?: boolean
  remaining_ms?: number
  current_level?: {
    level_no: number
    is_break: boolean
    small_blind: number
    big_blind: number
    bb_ante: number
    label?: string
  } | null
} | null

type Props = {
  sessionId: number
  clock: ClockLike
  /** When the clock snapshot was fetched — the panel ticks locally from it. */
  syncedAt: number
  onChanged: () => void
}

/**
 * The clock, desk-side, in two modes.
 *
 * Minimised: a slim strip above the seat grid — level, blinds, countdown,
 * and the controls (Start / Pause / Resume / level steps / maximise).
 * Maximised: the full Sichuan-style room display (TimerDisplay) as an
 * overlay with the same controls docked underneath.
 *
 * The clock itself is server-authoritative: minimising, maximising or
 * closing any view NEVER touches the time. Only Pause does.
 */
export default function ClockPanel({ sessionId, clock, syncedAt, onChanged }: Props) {
  const [maximised, setMaximised] = useState(false)
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(handle)
  }, [])

  const status = clock?.status ?? "draft"
  const running = clock?.running === true
  const level = clock?.current_level ?? null

  const remainingMs = clock?.remaining_ms !== undefined
    ? Math.max(0, clock.remaining_ms - (running ? now - syncedAt : 0))
    : null

  async function control(action: "start" | "pause" | "resume" | "next" | "prev") {
    if (busy) return
    setBusy(true)

    try {
      if (action === "start") {
        await deskApi.startClock(sessionId)
        notify("system", "Tournament started", "The clock is running — the night counts from here.", "success")
      } else if (action === "pause") {
        await deskApi.pauseClock(sessionId)
      } else if (action === "resume") {
        await deskApi.resumeClock(sessionId)
      } else if (action === "next") {
        await deskApi.nextLevel(sessionId)
      } else {
        await deskApi.previousLevel(sessionId)
      }
      onChanged()
    } catch {
      // The 5s seating poll re-syncs the truth either way.
    } finally {
      setBusy(false)
    }
  }

  const countdownText = remainingMs === null
    ? "--:--"
    : (() => {
        const total = Math.max(0, Math.ceil(remainingMs / 1000))
        const m = Math.floor(total / 60)
        const s = total % 60
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      })()

  const controls = (
    <>
      {status === "draft" ? (
        <button type="button" className="clock-panel__start" disabled={busy} onClick={() => void control("start")}>
          <Play size={15} /> Start
        </button>
      ) : status === "finished" ? (
        <span className="clock-panel__finished">Finished</span>
      ) : (
        <>
          <button type="button" className="clock-panel__btn" disabled={busy} title="Previous level" onClick={() => void control("prev")}>
            <ChevronLeft size={15} />
          </button>
          {running ? (
            <button type="button" className="clock-panel__btn clock-panel__btn--pause" disabled={busy} onClick={() => void control("pause")}>
              <Pause size={15} /> Pause
            </button>
          ) : (
            <button type="button" className="clock-panel__start" disabled={busy} onClick={() => void control("resume")}>
              <Play size={15} /> Resume
            </button>
          )}
          <button type="button" className="clock-panel__btn" disabled={busy} title="Next level" onClick={() => void control("next")}>
            <ChevronRight size={15} />
          </button>
        </>
      )}
    </>
  )

  return (
    <>
      <div className={`clock-panel clock-panel--${running ? "running" : status}`}>
        <span className="clock-panel__dot" aria-hidden="true" />
        <div className="clock-panel__level">
          {level ? (
            level.is_break ? (
              <strong>{level.label || "Break"}</strong>
            ) : (
              <>
                <strong>Level {level.level_no}</strong>
                <small>
                  {level.small_blind.toLocaleString()} / {level.big_blind.toLocaleString()}
                  {level.bb_ante ? ` (${level.bb_ante.toLocaleString()})` : ""}
                </small>
              </>
            )
          ) : (
            <strong>{status === "draft" ? "Ready to start" : "—"}</strong>
          )}
        </div>
        <strong className="clock-panel__time">{status === "draft" ? "" : countdownText}</strong>
        <div className="clock-panel__controls">{controls}</div>
        <button
          type="button"
          className="clock-panel__btn"
          title="Maximise the clock — the time itself never stops"
          onClick={() => setMaximised(true)}
        >
          <Maximize2 size={15} />
        </button>
      </div>

      {maximised ? (
        <div className="clock-max" role="dialog" aria-modal="true" aria-label="Tournament clock">
          <TimerDisplay sessionId={sessionId} />
          <div className="clock-max__dock">
            {controls}
            <button type="button" className="clock-panel__btn" title="Minimise" onClick={() => setMaximised(false)}>
              <Minimize2 size={15} /> Minimise
            </button>
            <button type="button" className="clock-panel__btn" title="Close — the clock keeps running" onClick={() => setMaximised(false)}>
              <X size={15} />
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}
