import { useEffect, useRef, useState } from "react"
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
 * Opened as its own window so it can live on a projector or a second screen
 * while the desk keeps working. The look mirrors the Sichuan room clock in
 * EdgeHost — a compact white card when minimised, the dark full-room panels
 * when maximised — but the time underneath is server-authoritative: every
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
  // Two layouts, one clock: "max" is the full room display, "mini" a
  // compact card. Maximising also takes the window fullscreen, the way
  // the Sichuan clock claims the whole screen; minimising releases it.
  const [mode, setMode] = useState<"max" | "mini">("max")
  // Sichuan's Zoom: hide everything but blind + time, oversized.
  const [zoomed, setZoomed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Level-change cue, the way the mahjong room clock announces a new
  // round: a short flash and a two-tone chime.
  const [levelFlash, setLevelFlash] = useState(false)
  const prevLevelRef = useRef<number | null>(null)

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
    if (mode !== "max") setZoomed(false)
  }, [mode])

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

  const levelLabel = `Level ${level?.level_no ?? "—"} / ${clock?.level_count ?? "—"}`
  const blindLabel = level?.is_break
    ? (level.note || "Break")
    : `${(level?.small_blind ?? 0).toLocaleString()} / ${(level?.big_blind ?? 0).toLocaleString()}`
  const nextLabel = clock?.next_level
    ? (clock.next_level.is_break
        ? (clock.next_level.note || "Break")
        : `${clock.next_level.small_blind.toLocaleString()} / ${clock.next_level.big_blind.toLocaleString()}`)
    : "Final level"

  if (error && !clock) {
    return (
      <div className="spkt-errorpage">
        <p>{error}</p>
      </div>
    )
  }

  const startPause = clock?.status === "draft" || !clock ? (
    <button type="button" className="spkt-runbtn spkt-runbtn--start" disabled={busy || !clock} onClick={() => void control("start")}>
      Start
    </button>
  ) : clock.status === "finished" ? (
    <span className="spkt-chip spkt-chip--done">Finished</span>
  ) : clock.running ? (
    <button type="button" className="spkt-runbtn spkt-runbtn--pause" disabled={busy} onClick={() => void control("pause")}>
      Pause
    </button>
  ) : (
    <button type="button" className="spkt-runbtn spkt-runbtn--start" disabled={busy} onClick={() => void control("resume")}>
      Resume
    </button>
  )

  const canStep = !!clock && clock.status !== "draft" && clock.status !== "finished"

  if (mode === "mini") {
    return (
      <div className="spkt-mini">
        <div className={`spkt-card${levelFlash ? " spkt-flash" : ""}`}>
          <div className="spkt-card__top">
            <button
              type="button"
              className="spkt-modebtn spkt-modebtn--light"
              title="Maximise the display — the clock keeps running"
              onClick={toggleMode}
            >
              Maximise
            </button>
          </div>

          <div className="spkt-card__body">
            <span className="spkt-label">Current Blind</span>
            <span className="spkt-levelchip">
              <strong>Level</strong> {level?.level_no ?? "—"} <em>/ {clock?.level_count ?? "—"}</em>
            </span>
            <span className={`spkt-card__blind${level?.is_break ? " spkt-break" : ""}`}>
              {blindLabel}
              {!level?.is_break && level && level.bb_ante > 0 ? ` (${level.bb_ante.toLocaleString()})` : ""}
            </span>
            <span className="spkt-label spkt-label--gap">Time Remaining</span>
            <span className="spkt-card__clock">{countdown(remaining)}</span>
            {paused ? <span className="spkt-warnchip">Paused</span> : null}
          </div>

          <div className="spkt-card__foot">
            {canStep ? (
              <>
                <button type="button" className="spkt-stepbtn" disabled={busy} title="Previous level" onClick={() => void control("prev")}>‹</button>
                <button type="button" className="spkt-stepbtn" disabled={busy} title="Next level" onClick={() => void control("next")}>›</button>
              </>
            ) : null}
            {startPause}
          </div>

          {error ? <p className="spkt-stale">{error}</p> : null}
        </div>
      </div>
    )
  }

  return (
    <div className={`spkt-full${levelFlash ? " spkt-flash" : ""}`}>
      <div className="spkt-full__inner">
        <div className="spkt-full__top">
          <button
            type="button"
            className="spkt-modebtn spkt-modebtn--dark"
            title="Minimise the display — the clock keeps running"
            onClick={toggleMode}
          >
            Minimise
          </button>
        </div>

        <div className="spkt-full__bar">
          <div className="spkt-full__bar-side">
            <span className="spkt-full__title">{clock?.name ?? "Tournament"}</span>
            {clock?.venue_name ? <span className="spkt-chip">{clock.venue_name}</span> : null}
            <span className="spkt-chip">{level?.is_break ? "Break" : levelLabel}</span>
          </div>
          <div className="spkt-full__bar-side spkt-full__bar-side--end">
            <span className="spkt-chip">Next: {nextLabel}</span>
            {startPause}
          </div>
        </div>

        <div className="spkt-full__center">
          <div className={`spkt-panel spkt-panel--main${zoomed ? " spkt-panel--zoomed" : ""}`}>
            <button
              type="button"
              className="spkt-zoombtn"
              title={zoomed ? "Back to the normal full timer" : "Zoom blind and timer"}
              onClick={() => setZoomed((z) => !z)}
            >
              {zoomed ? "Unzoom" : "Zoom"}
            </button>

            <span className="spkt-label spkt-label--dark">Current Blind</span>
            <span className={`spkt-panel__blind${level?.is_break ? " spkt-break" : ""}`}>{blindLabel}</span>
            <span className="spkt-panel__meta">
              {levelLabel}
              {!level?.is_break && level && level.bb_ante > 0 ? ` · Ante ${level.bb_ante.toLocaleString()}` : ""}
            </span>
            <span className="spkt-label spkt-label--dark spkt-label--gap">Time Remaining</span>
            <span className="spkt-panel__clock">{countdown(remaining)}</span>
            {paused ? (
              <span className="spkt-warnchip"><i />Paused — the clock is stopped</span>
            ) : urgent ? (
              <span className="spkt-warnchip"><i />Less than 60 seconds</span>
            ) : null}
          </div>

          {!zoomed ? (
            <div className="spkt-panel spkt-panel--next">
              <span className="spkt-label spkt-label--dark">Next</span>
              <span className="spkt-panel__next">{nextLabel}</span>
              {canStep ? (
                <div className="spkt-panel__nav">
                  <button type="button" className="spkt-navbtn" disabled={busy} onClick={() => void control("prev")}>Prev</button>
                  <button type="button" className="spkt-navbtn" disabled={busy} onClick={() => void control("next")}>Next</button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="spkt-stats">
          <div className="spkt-stat">
            <span>Total Players</span>
            <strong>{summary.total_players?.toLocaleString() ?? "—"}</strong>
          </div>
          <div className="spkt-stat">
            <span>Active Players</span>
            <strong>{summary.active_players?.toLocaleString() ?? "—"}</strong>
          </div>
          <div className="spkt-stat">
            <span>Avg Stack</span>
            <strong>{summary.average_stack ? summary.average_stack.toLocaleString() : "—"}</strong>
          </div>
          {gates?.registration.open && gates.registration.closes_in_ms !== null ? (
            <div className="spkt-stat">
              <span>Reg Closes</span>
              <strong>{countdown(Math.max(0, gates.registration.closes_in_ms - elapsed))}</strong>
            </div>
          ) : gates && !gates.registration.open ? (
            <div className="spkt-stat spkt-stat--shut">
              <span>Registration</span>
              <strong>Closed</strong>
            </div>
          ) : null}
        </div>

        {error ? <p className="spkt-stale spkt-stale--dark">{error}</p> : null}
      </div>
    </div>
  )
}
