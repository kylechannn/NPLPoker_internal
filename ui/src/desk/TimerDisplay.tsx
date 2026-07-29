import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Pause, Play, X } from "lucide-react"
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

/** The popup's native chrome is stripped by the Go host, keyed on this
 *  exact title — keep them in sync with desktop_windows.go. */
const WINDOW_TITLE = "NPL Room Clock"

/** A short two-tone chime on level change; deeper pair for a break. */
function chime(isBreak: boolean) {
  try {
    const ctx = new AudioContext()
    const tone = (freq: number, at: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      osc.type = "sine"
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.5)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + at)
      osc.stop(ctx.currentTime + at + 0.55)
    }
    tone(isBreak ? 392 : 660, 0)
    tone(isBreak ? 294 : 880, 0.28)
    window.setTimeout(() => void ctx.close(), 1200)
  } catch {
    // No audio device / autoplay blocked: the flash still announces it.
  }
}

/**
 * The room display: the clock as everyone at the tables reads it.
 *
 * Opened with window.open so it owns a real window: minimise shrinks it
 * into a mini clock widget, maximise takes the projector fullscreen.
 * The Go host removes the system title bar, so the page draws its own —
 * the strip at the top drags the window and the ✕ closes it. The clock
 * itself is server-authoritative: every window derives the same
 * countdown from the same timestamps, so a reload changes nothing.
 */
export default function TimerDisplay({ sessionId }: { sessionId: number }) {
  const [clock, setClock] = useState<ClockState | null>(null)
  const [summary, setSummary] = useState<Summary>({})
  const [gates, setGates] = useState<Gates | null>(null)
  const [syncedAt, setSyncedAt] = useState(0)
  const [now, setNow] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<"max" | "mini">("max")
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Level-change cue, the way the mahjong room clock announces a new
  // round: a short flash and a two-tone chime.
  const [levelFlash, setLevelFlash] = useState(false)
  const prevLevelRef = useRef<number | null>(null)

  useEffect(() => {
    document.title = WINDOW_TITLE
  }, [])

  useEffect(() => {
    const levelNo = clock?.current_level?.level_no ?? null
    if (levelNo === null) return

    if (prevLevelRef.current !== null && prevLevelRef.current !== levelNo) {
      setLevelFlash(true)
      chime(clock?.current_level?.is_break === true)
      const handle = window.setTimeout(() => setLevelFlash(false), 2000)
      return () => window.clearTimeout(handle)
    }

    prevLevelRef.current = levelNo
  }, [clock?.current_level?.level_no, clock?.current_level?.is_break])

  useEffect(() => {
    prevLevelRef.current = clock?.current_level?.level_no ?? prevLevelRef.current
  }, [clock?.current_level?.level_no])

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
  }, [sessionId, refreshKey])

  async function control(action: "start" | "pause" | "resume" | "next" | "prev") {
    if (busy) return
    setBusy(true)

    try {
      if (action === "start") await deskApi.startClock(sessionId)
      else if (action === "pause") await deskApi.pauseClock(sessionId)
      else if (action === "resume") await deskApi.resumeClock(sessionId)
      else if (action === "next") await deskApi.nextLevel(sessionId)
      else await deskApi.previousLevel(sessionId)
      setRefreshKey((key) => key + 1)
    } catch {
      // The 5s sync corrects the view either way.
    } finally {
      setBusy(false)
    }
  }

  // One button, two jobs: the layout switch and the window itself move
  // together. Minimise shrinks the real window into a mini clock;
  // Maximise goes fullscreen. resizeTo is allowed here because the desk
  // opened this window with window.open.
  async function toggleMode() {
    if (mode === "max") {
      setMode("mini")
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
      } catch {
        // Fullscreen already gone; the resize below still applies.
      }
      window.resizeTo(420, 560)
    } else {
      setMode("max")
      document.documentElement.requestFullscreen().catch(() => {
        // Fullscreen refused (rare in the desk shell): at least give the
        // room a projector-sized window again.
        window.resizeTo(1280, 720)
      })
    }
  }

  // The frameless window's drag handle. moveBy is permitted for
  // script-opened popups; screen coordinates keep the deltas stable
  // while the window itself is moving under the pointer.
  function startTitleDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest("button")) return
    if (document.fullscreenElement) return

    let lastX = event.screenX
    let lastY = event.screenY

    const move = (ev: PointerEvent) => {
      window.moveBy(ev.screenX - lastX, ev.screenY - lastY)
      lastX = ev.screenX
      lastY = ev.screenY
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

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
  const paused = clock?.status === "paused"
  const level = clock?.current_level ?? null
  const isBreak = level?.is_break === true

  const progress = useMemo(() => {
    if (!clock || clock.level_duration_ms <= 0) return 0
    return Math.min(100, Math.max(0, (1 - remaining / clock.level_duration_ms) * 100))
  }, [clock, remaining])

  const blindLabel = isBreak
    ? (level?.note || "Break")
    : `${(level?.small_blind ?? 0).toLocaleString()} / ${(level?.big_blind ?? 0).toLocaleString()}`
  const nextLabel = clock?.next_level
    ? (clock.next_level.is_break
        ? (clock.next_level.note || "Break")
        : `${clock.next_level.small_blind.toLocaleString()} / ${clock.next_level.big_blind.toLocaleString()}`)
    : "Final level"

  const tone = paused ? "paused" : isBreak ? "break" : clock?.running ? "live" : "idle"
  const stateClasses = [
    paused ? " rc--paused" : "",
    urgent && !paused ? " rc--urgent" : "",
    isBreak ? " rc--break" : "",
    levelFlash ? " rc--flash" : "",
  ].join("")

  if (error && !clock) {
    return (
      <div className="rc rc--mini rc--error">
        <header className="rc-titlebar" onPointerDown={startTitleDrag}>
          <span className="rc-dot rc-dot--idle" />
          <span className="rc-titlebar__label">Room Clock</span>
          <span className="rc-titlebar__spacer" />
          <button type="button" className="rc-winbtn rc-winbtn--close" title="Close" onClick={() => window.close()}>
            <X size={15} strokeWidth={2.2} />
          </button>
        </header>
        <div className="rc-errorbody">
          <p>{error}</p>
        </div>
      </div>
    )
  }

  const titlebar = (
    <header className="rc-titlebar" onPointerDown={startTitleDrag} onDoubleClick={() => void toggleMode()}>
      <span className={`rc-dot rc-dot--${tone}`} />
      <span className="rc-titlebar__label">
        {mode === "max" ? (clock?.name ?? "Room Clock") : "Room Clock"}
      </span>
      {mode === "max" && clock?.venue_name ? (
        <span className="rc-titlebar__venue">{clock.venue_name}</span>
      ) : null}
      <span className="rc-titlebar__spacer" />
      <button
        type="button"
        className="rc-winbtn"
        title={mode === "max" ? "Minimise into a mini clock" : "Maximise to fullscreen"}
        onClick={() => void toggleMode()}
      >
        {mode === "max" ? <Minimize2 size={14} strokeWidth={2} /> : <Maximize2 size={14} strokeWidth={2} />}
      </button>
      <button type="button" className="rc-winbtn rc-winbtn--close" title="Close the display" onClick={() => window.close()}>
        <X size={15} strokeWidth={2.2} />
      </button>
    </header>
  )

  const dock = (
    <div className="rc-dock" role="group" aria-label="Clock controls">
      {clock?.status === "draft" || !clock ? (
        <button type="button" className="rc-btn rc-btn--run rc-btn--go" disabled={busy || !clock} onClick={() => void control("start")}>
          <Play size={15} strokeWidth={2.4} /> Start
        </button>
      ) : clock.status === "finished" ? (
        <span className="rc-done">Finished</span>
      ) : (
        <>
          <button type="button" className="rc-btn" disabled={busy} title="Previous level" onClick={() => void control("prev")}>
            <ChevronLeft size={17} strokeWidth={2.2} />
          </button>
          {clock.running ? (
            <button type="button" className="rc-btn rc-btn--run rc-btn--hold" disabled={busy} onClick={() => void control("pause")}>
              <Pause size={15} strokeWidth={2.4} /> Pause
            </button>
          ) : (
            <button type="button" className="rc-btn rc-btn--run rc-btn--go" disabled={busy} onClick={() => void control("resume")}>
              <Play size={15} strokeWidth={2.4} /> Resume
            </button>
          )}
          <button type="button" className="rc-btn" disabled={busy} title="Next level" onClick={() => void control("next")}>
            <ChevronRight size={17} strokeWidth={2.2} />
          </button>
        </>
      )}
    </div>
  )

  const statusChip = paused ? (
    <span className="rc-chip rc-chip--paused">Paused</span>
  ) : clock?.status === "draft" ? (
    <span className="rc-chip rc-chip--idle">Ready</span>
  ) : clock?.status === "finished" ? (
    <span className="rc-chip rc-chip--idle">Finished</span>
  ) : isBreak ? (
    <span className="rc-chip rc-chip--break">Break</span>
  ) : (
    <span className="rc-chip">Level {level?.level_no ?? "—"} <em>/ {clock?.level_count ?? "—"}</em></span>
  )

  if (mode === "mini") {
    return (
      <div className={`rc rc--mini${stateClasses}`}>
        {titlebar}

        <div className="rc-mini__body">
          {statusChip}
          <span className="rc-count rc-count--mini">{countdown(remaining)}</span>
          <span className="rc-blinds rc-blinds--mini">{blindLabel}</span>
          {!isBreak && level && level.bb_ante > 0 ? (
            <span className="rc-ante">ante {level.bb_ante.toLocaleString()}</span>
          ) : null}
          <span className="rc-next">Next · {nextLabel}</span>
        </div>

        {dock}

        {error ? <p className="rc-stale">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className={`rc rc--max${stateClasses}`}>
      {titlebar}

      <main className="rc-max__main">
        {statusChip}
        <span className="rc-count rc-count--max">{countdown(remaining)}</span>
        <div className="rc-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <span className="rc-blinds rc-blinds--max">{blindLabel}</span>
        {!isBreak && level && level.bb_ante > 0 ? (
          <span className="rc-ante rc-ante--max">ante {level.bb_ante.toLocaleString()}</span>
        ) : null}
      </main>

      {dock}

      <footer className="rc-max__stats">
        <div className="rc-stat">
          <span>Next</span>
          <strong>{nextLabel}</strong>
        </div>
        <div className="rc-stat">
          <span>Players</span>
          <strong>
            {summary.active_players ?? "—"}
            {summary.total_players ? <em> / {summary.total_players}</em> : null}
          </strong>
        </div>
        <div className="rc-stat">
          <span>Avg stack</span>
          <strong>{summary.average_stack ? summary.average_stack.toLocaleString() : "—"}</strong>
        </div>
        {gates?.registration.open && gates.registration.closes_in_ms !== null ? (
          <div className="rc-stat rc-stat--gate">
            <span>Reg closes</span>
            <strong>{countdown(Math.max(0, gates.registration.closes_in_ms - elapsed))}</strong>
          </div>
        ) : gates && !gates.registration.open ? (
          <div className="rc-stat rc-stat--shut">
            <span>Registration</span>
            <strong>Closed</strong>
          </div>
        ) : null}
      </footer>

      {error ? <p className="rc-stale">{error}</p> : null}
    </div>
  )
}
