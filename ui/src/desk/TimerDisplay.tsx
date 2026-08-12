import { useCallback, useEffect, useRef, useState } from "react"
import { Clock, Coffee, Coins, Copy, Minus, PlusCircle, RefreshCw, Square, Users, X } from "lucide-react"
import { countdown, deskApi, type AddonTier, type PrizeBreakdownRow, type Seating } from "./deskApi"
import nplLogoUrl from "../assets/npl-logo.png"
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
  next_break?: {
    index: number
    label: string
    in_ms: number
    on_break: boolean
    duration_min?: number | null
  } | null
}

type Summary = {
  total_players?: number
  active_players?: number
  entries?: number
  total_chips?: number
  average_stack?: number
  total_rebuys?: number
  total_addons?: number
}

type DisplayExtras = {
  /** The linked cloud game's payout ladder — never typed at the desk. */
  prize_breakdown: PrizeBreakdownRow[] | null
  prize_guarantee: string | null
  /** The venue's chip set, typed once in the session settings. */
  chip_denominations: string | null
  /** Configured price/chip tiers — the idle info bar reads the first of each. */
  rebuy_tiers: AddonTier[]
  addon_tiers: AddonTier[]
}

/** Cents → dollar text, no decimals unless the amount needs them. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** How long the control bar lingers after the last touch. Hard-coded. */
const CONTROL_BAR_IDLE_MS = 3000

const SYNC_MS = 5000
// The bar's CSS transition is matched to this — a 4x/sec re-render bought
// no visible smoothness the transition doesn't already give a 1s tick.
const TICK_MS = 1000

/** Matches the native window title in desktop_windows.go; also names
 *  the tab when the page runs in a plain browser during development. */
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

/** The right rail alternates chips ↔ prizes on this fixed cadence. */
const RAIL_SWAP_MS = 10_000

/** The standard NPL chip set — shown when the desk typed no denominations. */
const DEFAULT_DENOMS = ["25", "100", "500", "1K", "5K", "10K", "25K", "100K"]

/** Casino colour per canonical chip value; slate for anything unusual. */
const CHIP_COLORS: Array<[number, string]> = [
  [25, "#1e9e50"],
  [100, "#3c434e"],
  [500, "#d81f3d"],
  [1_000, "#d9a514"],
  [5_000, "#2160d8"],
  [10_000, "#7c3aed"],
  [25_000, "#e2661b"],
  [100_000, "#d81f8f"],
]

/** "1K" → 1000, "25,000" → 25000, "100k" → 100000; null when not a number. */
function chipTokenValue(token: string): number | null {
  const match = /^\$?\s*([\d.,]+)\s*(k|K)?$/.exec(token.trim())
  if (!match) return null
  const base = Number(match[1].replace(/,/g, ""))
  if (!Number.isFinite(base)) return null
  return Math.round(base * (match[2] ? 1000 : 1))
}

function chipColor(token: string): string {
  const value = chipTokenValue(token)
  return CHIP_COLORS.find(([denom]) => denom === value)?.[1] ?? "#4a5261"
}

/** The desk's free-text chip list → up to 9 rail rows. */
function parseDenominations(text: string | null): string[] {
  const tokens = (text ?? "")
    .split(/[,;|\n]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 9)
  return tokens.length > 0 ? tokens : DEFAULT_DENOMS
}

/** An SVG arc path on the dial's coordinate system (centre 500,500). */
function arcPath(radius: number, startDeg: number, endDeg: number): string {
  const point = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return `${(500 + radius * Math.cos(rad)).toFixed(2)} ${(500 + radius * Math.sin(rad)).toFixed(2)}`
  }
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0
  return `M ${point(startDeg)} A ${radius} ${radius} 0 ${large} 1 ${point(endDeg)}`
}

/**
 * A stylised NPL chip with real lighting: coloured rim lit from the
 * upper-left, six edge stripes, a radial-dark inlay with a specular
 * sweep, sitting on its own ground shadow. Gradient ids derive from the
 * colour, so same-colour chips share identical (harmless) definitions.
 */
function ChipIcon({ color }: { color: string }) {
  const gradId = `chip-${color.replace("#", "")}`
  return (
    <svg className="mx-chipicon" viewBox="0 0 40 42" aria-hidden="true">
      <defs>
        <radialGradient id={`${gradId}-rim`} cx="0.34" cy="0.28" r="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.40" />
          <stop offset="0.34" stopColor="#ffffff" stopOpacity="0.10" />
          <stop offset="0.72" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.42" />
        </radialGradient>
        <radialGradient id={`${gradId}-in`} cx="0.42" cy="0.34" r="0.85">
          <stop offset="0" stopColor="#20242f" />
          <stop offset="0.58" stopColor="#12151d" />
          <stop offset="1" stopColor="#06070b" />
        </radialGradient>
      </defs>
      {/* Ground shadow. */}
      <ellipse cx="20" cy="38.4" rx="14.5" ry="2.6" fill="rgba(0, 0, 0, 0.5)" />
      <circle cx="20" cy="20" r="19" fill={color} />
      {Array.from({ length: 6 }, (_, index) => (
        <rect
          key={index}
          x="17.4"
          y="1.4"
          width="5.2"
          height="6.4"
          rx="1.8"
          fill="#f2f4f8"
          transform={`rotate(${index * 60} 20 20)`}
        />
      ))}
      {/* The light falls across rim and stripes alike. */}
      <circle cx="20" cy="20" r="19" fill={`url(#${gradId}-rim)`} />
      <circle cx="20" cy="20" r="11.6" fill={`url(#${gradId}-in)`} stroke="rgba(255,255,255,0.78)" strokeWidth="1" />
      {/* Specular sweep on the inlay. */}
      <path
        d="M 11.7 15.2 A 9.6 9.6 0 0 1 27.35 13.83"
        fill="none"
        stroke="rgba(255,255,255,0.32)"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <text x="20" y="23" textAnchor="middle" fontSize="8" fontWeight="800" fill="#ffffff">NPL</text>
    </svg>
  )
}

/**
 * The room display: the clock as everyone at the tables reads it.
 *
 * The window is built by the Go host (chrome-less, movable by the strip
 * at the top); the face below the title bar is the Sichuan clock from
 * EdgeHost, poker data in its slots: the compact white card when
 * minimised, the photo-backed slate panels when maximised. The clock is
 * server-authoritative — every window derives the same countdown from
 * the same timestamps, so a reload changes nothing.
 */
export default function TimerDisplay({ sessionId }: { sessionId: number }) {
  const [clock, setClock] = useState<ClockState | null>(null)
  const [summary, setSummary] = useState<Summary>({})
  const [extras, setExtras] = useState<DisplayExtras>({ prize_breakdown: null, prize_guarantee: null, chip_denominations: null, rebuy_tiers: [], addon_tiers: [] })
  const [syncedAt, setSyncedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  // The window opens as the mini widget (the Go host sizes it to match)
  // and grows to the projector display on demand. `?layout=max` starts
  // straight on the big design — projector setups and screenshots.
  const [mode, setMode] = useState<"max" | "mini">(() =>
    new URLSearchParams(window.location.search).get("layout") === "max" ? "max" : "mini")
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Level-change cue, the way the mahjong room clock announces a new
  // round: a short flash and a two-tone chime.
  const [levelFlash, setLevelFlash] = useState(false)
  const prevLevelRef = useRef<number | null>(null)
  // The right rail's two faces: the chip set and the payout ladder.
  const [rail, setRail] = useState<"chips" | "prizes">("chips")
  // The bottom strip: session info at rest; pressing anywhere brings the
  // controls up, and 3 idle seconds put the info back. Hovering holds it.
  const [barMode, setBarMode] = useState<"info" | "controls">("info")
  const barIdleTimer = useRef<number | null>(null)

  const armBarRevert = useCallback(() => {
    if (barIdleTimer.current !== null) window.clearTimeout(barIdleTimer.current)
    barIdleTimer.current = window.setTimeout(() => setBarMode("info"), CONTROL_BAR_IDLE_MS)
  }, [])

  const holdBar = useCallback(() => {
    if (barIdleTimer.current !== null) window.clearTimeout(barIdleTimer.current)
  }, [])

  const showControls = useCallback(() => {
    setBarMode("controls")
    armBarRevert()
  }, [armBarRevert])

  useEffect(() => () => {
    if (barIdleTimer.current !== null) window.clearTimeout(barIdleTimer.current)
  }, [])

  // Esc walks the projector view back to the mini clock.
  useEffect(() => {
    if (mode !== "max") return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setMode("mini")
      if (window.nplClockLayout) {
        void window.nplClockLayout("mini")
        return
      }
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
      window.resizeTo(420, 560)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [mode])

  useEffect(() => {
    document.title = WINDOW_TITLE
  }, [])

  // The rail alternates on a fixed 10s cadence — only when there is a
  // prize ladder to alternate TO; otherwise the chips simply stay.
  const hasPrizes = (extras.prize_breakdown?.length ?? 0) > 0 || Boolean(extras.prize_guarantee)
  useEffect(() => {
    if (!hasPrizes) {
      setRail("chips")
      return
    }
    const handle = window.setInterval(
      () => setRail((face) => (face === "chips" ? "prizes" : "chips")),
      RAIL_SWAP_MS,
    )
    return () => window.clearInterval(handle)
  }, [hasPrizes])

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
          entries: seating.counts.entries,
          total_chips: seating.counts.total_chips,
          average_stack: seating.counts.average_stack,
          total_rebuys: seating.counts.total_rebuys,
          total_addons: seating.counts.total_addons,
        })
        setExtras({
          prize_breakdown: seating.display?.prize_breakdown ?? null,
          prize_guarantee: seating.display?.prize_guarantee ?? null,
          chip_denominations: seating.display?.chip_denominations ?? null,
          rebuy_tiers: seating.rebuy_tiers ?? [],
          addon_tiers: seating.addon_tiers ?? [],
        })
        setSyncedAt(Date.now())
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Lost contact with the desk.")
      }
    }

    void pull()
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull()
    }, SYNC_MS)
    // Level/pause changes made from another window while this one was
    // hidden need an actual sync to show up — the tick alone can't know.
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") void pull()
    }
    document.addEventListener("visibilitychange", syncWhenVisible)

    return () => {
      cancelled = true
      window.clearInterval(handle)
      document.removeEventListener("visibilitychange", syncWhenVisible)
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
  // together. In the desktop shell the Go host resizes its own window
  // ("mini" = small centred widget, "max" = edge-to-edge on the
  // monitor); the fallbacks cover the page running in a plain browser.
  async function toggleMode() {
    if (mode === "max") {
      setMode("mini")
      if (window.nplClockLayout) {
        void window.nplClockLayout("mini")
        return
      }
      try {
        if (document.fullscreenElement) await document.exitFullscreen()
      } catch {
        // Fullscreen already gone; the resize below still applies.
      }
      window.resizeTo(420, 560)
    } else {
      setMode("max")
      if (window.nplClockLayout) {
        void window.nplClockLayout("max")
        return
      }
      document.documentElement.requestFullscreen().catch(() => {
        window.resizeTo(1280, 720)
      })
    }
  }

  // The frameless window's drag handle: the native hit-test drag in the
  // desktop shell, moveBy deltas as the browser fallback.
  function startTitleDrag(event: React.PointerEvent<HTMLElement>) {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest("button")) return

    if (window.nplWindowStartDrag) {
      void window.nplWindowStartDrag()
      return
    }

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

  function closeWindow() {
    if (window.nplWindowClose) {
      void window.nplWindowClose()
      return
    }
    window.close()
  }

  // Ticks locally between syncs so the seconds move smoothly; every sync
  // re-bases against the server, so drift never accumulates.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now())
    }, TICK_MS)
    // now is a wall-clock read, not an accumulated counter, so a tick
    // skipped while hidden causes no drift — this just repaints instantly
    // instead of waiting up to a second for the next regular tick.
    const tickWhenVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now())
    }
    document.addEventListener("visibilitychange", tickWhenVisible)
    return () => {
      window.clearInterval(handle)
      document.removeEventListener("visibilitychange", tickWhenVisible)
    }
  }, [])

  const elapsed = now > syncedAt && syncedAt > 0 ? now - syncedAt : 0
  const remaining = clock
    ? (clock.running ? Math.max(0, clock.remaining_ms - elapsed) : clock.remaining_ms)
    : 0

  const urgent = clock?.running === true && remaining <= 60_000
  const paused = clock?.status === "paused"
  const level = clock?.current_level ?? null
  const isBreak = level?.is_break === true

  const progress = clock && clock.level_duration_ms > 0
    ? Math.min(100, Math.max(0, (1 - remaining / clock.level_duration_ms) * 100))
    : 0

  const blindLabel = isBreak
    ? (level?.note || "Break")
    : `${(level?.small_blind ?? 0).toLocaleString()}/${(level?.big_blind ?? 0).toLocaleString()}`
  const nextLabel = clock?.next_level
    ? (clock.next_level.is_break
        ? (clock.next_level.note || "Break")
        : `${clock.next_level.small_blind.toLocaleString()}/${clock.next_level.big_blind.toLocaleString()}`)
    : "Final level"

  const tone = paused ? "paused" : isBreak ? "break" : clock?.running ? "live" : "idle"

  // Players remaining against total entries, the way the room reads it:
  // 50/65 — everyone still in versus everyone who bought a seat.
  const playersLabel = summary.active_players !== undefined && summary.entries !== undefined
    ? `${summary.active_players.toLocaleString()}/${summary.entries.toLocaleString()}`
    : summary.active_players?.toLocaleString() ?? "—"

  const nextBreak = clock?.next_break ?? null
  const nextBreakLabel = nextBreak
    ? (nextBreak.on_break ? "Now" : countdown(Math.max(0, nextBreak.in_ms - (clock?.running ? elapsed : 0))))
    : null

  // The big display's cards, in the design's own voice.
  const wallTime = (at: number) => new Date(at)
    .toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true })
    .toUpperCase()
  const timeNowLabel = wallTime(now)
  const breakCardLabel = nextBreak?.duration_min
    ? `Next ${nextBreak.duration_min} Minute Break`
    : "Next Break"
  const breakAtLabel = nextBreak
    ? (nextBreak.on_break
        ? "NOW"
        : wallTime(now + Math.max(0, nextBreak.in_ms - (clock?.running ? elapsed : 0))))
    : "—"
  const entriesLabel = `${(summary.active_players ?? 0).toLocaleString()}/${(summary.entries ?? 0).toLocaleString()}`
  const averageStackLabel = (summary.average_stack ?? 0).toLocaleString()
  const rebuysLabel = (summary.total_rebuys ?? 0).toLocaleString()
  const addonsLabel = (summary.total_addons ?? 0).toLocaleString()

  const denominations = parseDenominations(extras.chip_denominations)
  const prizeRows = extras.prize_breakdown ?? []

  // Sichuan's one run button, with poker's third state: Start when the
  // clock has never run, Pause while it runs, Resume after a pause.
  const run = clock?.status === "finished"
    ? null
    : !clock || clock.status === "draft"
      ? { label: "Start", action: "start" as const, go: true }
      : clock.running
        ? { label: "Pause", action: "pause" as const, go: false }
        : { label: "Resume", action: "resume" as const, go: true }

  const canStep = !!clock && clock.status !== "draft" && clock.status !== "finished"

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
      {window.nplWindowMinimize ? (
        <button
          type="button"
          className="rc-winbtn"
          title="Hide the clock"
          aria-label="Minimize window"
          onClick={() => void window.nplWindowMinimize?.()}
        >
          <Minus size={15} strokeWidth={1.7} />
        </button>
      ) : null}
      <button
        type="button"
        className="rc-winbtn"
        title={mode === "max" ? "Restore to the mini clock" : "Maximise the display"}
        aria-label={mode === "max" ? "Restore window" : "Maximize window"}
        onClick={() => void toggleMode()}
      >
        {mode === "max" ? <Copy size={13} strokeWidth={1.6} /> : <Square size={12} strokeWidth={1.6} />}
      </button>
      <button type="button" className="rc-winbtn rc-winbtn--close" title="Close the display" aria-label="Close window" onClick={closeWindow}>
        <span><X size={16} strokeWidth={2.2} /></span>
      </button>
    </header>
  )

  if (error && !clock) {
    return (
      <div className="rc rc--error">
        {titlebar}
        <div className="rc-errorbody">
          <p>{error}</p>
        </div>
      </div>
    )
  }

  if (mode === "mini") {
    return (
      <div className={`rc rc--sichuan${levelFlash ? " rc--flash" : ""}`}>
        {titlebar}

        <div className="scm-page">
          <div className="scm-card">
            <div className="scm-body">
              <div className="scm-label">Current Blind</div>

              <div className="scm-levelpill">
                <strong>Level</strong>
                <span className="scm-levelpill__num">{level?.level_no ?? "—"}</span>
                <em>/</em>
                <span className="scm-levelpill__total">{clock?.level_count ?? "—"}</span>
              </div>

              <div className="scm-blind">{blindLabel}</div>
              {!isBreak && level && level.bb_ante > 0 ? (
                <div className="scm-ante">Ante {level.bb_ante.toLocaleString()}</div>
              ) : null}

              <div className="scm-label scm-label--gap">Time Remaining</div>
              <div className={`scm-clock${urgent ? " scm-clock--urgent" : ""}`}>{countdown(remaining)}</div>
              <div className="scm-progress" aria-hidden="true">
                <span className={urgent ? "scm-progress--urgent" : undefined} style={{ transform: `scaleX(${progress / 100})` }} />
              </div>
              {paused ? <div className="scm-paused">Paused</div> : null}
              <div className="scm-next">Next · {nextLabel}</div>
              {nextBreakLabel && !isBreak ? <div className="scm-next">Break · {nextBreakLabel}</div> : null}
            </div>

            <div className="scm-foot">
              {canStep ? (
                <>
                  <button type="button" className="scm-pill scm-pill--ghost" disabled={busy} title="Previous level" onClick={() => void control("prev")}>‹</button>
                  <button type="button" className="scm-pill scm-pill--ghost" disabled={busy} title="Next level" onClick={() => void control("next")}>›</button>
                </>
              ) : null}
              {run ? (
                <button
                  type="button"
                  className={`scm-pill${run.go ? " scm-pill--go" : ""}`}
                  disabled={busy || !clock}
                  onClick={() => void control(run.action)}
                >
                  {run.label}
                </button>
              ) : (
                <span className="scm-finished">Finished</span>
              )}
            </div>
          </div>
        </div>

        {error ? <p className="rc-stale rc-stale--light">{error}</p> : null}
      </div>
    )
  }

  // The countdown ring: red = time ELAPSED in the current level. Empty at
  // the level's first second, a full red lap exactly as it rolls over.
  const RING_RADIUS = 468
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

  return (
    <div className={`rc rc--sichuan rc--max${levelFlash ? " rc--flash" : ""}`}>
      {titlebar}

      <div className="mx-page" onPointerDown={showControls}>
        <div className="mx-glow mx-glow--left" aria-hidden="true" />
        <div className="mx-glow mx-glow--right" aria-hidden="true" />
        <div className="mx-glow mx-glow--rightlow" aria-hidden="true" />

        <header className="mx-top">
          <div className="mx-brand">
            <img src={nplLogoUrl} alt="NPL" />
            <span className="mx-brand__name">National<br />Poker League</span>
          </div>
          <div className="mx-url">www.npl.com.au</div>
        </header>

        <div className="mx-grid">
          <aside className="mx-col">
            <div className="mx-card">
              <Clock className="mx-card__icon" strokeWidth={1.9} />
              <div className="mx-card__text">
                <span className="mx-card__label">Current Time</span>
                <strong className="mx-card__value">{timeNowLabel}</strong>
              </div>
            </div>

            <div className="mx-card">
              <Coffee className="mx-card__icon" strokeWidth={1.9} />
              <div className="mx-card__text">
                <span className="mx-card__label">{breakCardLabel}</span>
                <strong className="mx-card__value">{breakAtLabel}</strong>
              </div>
            </div>

            <div className="mx-card">
              <Users className="mx-card__icon" strokeWidth={1.9} />
              <div className="mx-card__text">
                <span className="mx-card__label">Entries</span>
                <strong className="mx-card__value">{entriesLabel}</strong>
              </div>
            </div>

            <div className="mx-card">
              <Coins className="mx-card__icon" strokeWidth={1.9} />
              <div className="mx-card__text">
                <span className="mx-card__label">Average Stack</span>
                <strong className="mx-card__value">{averageStackLabel}</strong>
              </div>
            </div>

            <div className="mx-pair">
              <div className="mx-card mx-card--half">
                <RefreshCw className="mx-card__icon" strokeWidth={1.9} />
                <div className="mx-card__text">
                  <span className="mx-card__label">Rebuys</span>
                  <strong className="mx-card__value">{rebuysLabel}</strong>
                </div>
              </div>
              <div className="mx-card mx-card--half">
                <PlusCircle className="mx-card__icon" strokeWidth={1.9} />
                <div className="mx-card__text">
                  <span className="mx-card__label">Add-ons</span>
                  <strong className="mx-card__value">{addonsLabel}</strong>
                </div>
              </div>
            </div>
          </aside>

          <main className="mx-center">
            <div className="mx-dial">
              <svg className="mx-ring" viewBox="0 0 1000 1000" aria-hidden="true">
                <defs>
                  {/* The arc: deep red into the tail, hot red toward the head. */}
                  <linearGradient id="mxRingRed" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#f5314a" />
                    <stop offset="0.55" stopColor="#d81f3d" />
                    <stop offset="1" stopColor="#7f0817" />
                  </linearGradient>
                  {/* The bezel: machined gunmetal, lit from the upper left. */}
                  <linearGradient id="mxRingBezel" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3a3e46" />
                    <stop offset="0.5" stopColor="#1b1d22" />
                    <stop offset="1" stopColor="#0c0d10" />
                  </linearGradient>
                  {/* The face: a screen-dark radial, faintly lit centre. */}
                  {/* The tube's lit core. */}
                  <linearGradient id="mxRingCore" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#ffc2c9" />
                    <stop offset="0.6" stopColor="#ff5163" />
                    <stop offset="1" stopColor="#c01130" />
                  </linearGradient>
                  {/* The whisper of glass over the face. */}
                  <radialGradient id="mxRingGlass" cx="0.5" cy="0.16" r="0.85">
                    <stop offset="0" stopColor="rgba(255,255,255,0.05)" />
                    <stop offset="0.45" stopColor="rgba(255,255,255,0.015)" />
                    <stop offset="1" stopColor="rgba(255,255,255,0)" />
                  </radialGradient>
                  <radialGradient id="mxRingFace" cx="0.5" cy="0.42" r="0.75">
                    <stop offset="0" stopColor="#15171c" />
                    <stop offset="0.72" stopColor="#0b0c0f" />
                    <stop offset="1" stopColor="#060708" />
                  </radialGradient>
                </defs>
                <circle className="mx-ring__face" cx="500" cy="500" r={RING_RADIUS} fill="url(#mxRingFace)" />
                <circle className="mx-ring__track" cx="500" cy="500" r={RING_RADIUS} stroke="url(#mxRingBezel)" />
                {/* Machined bezel: segment notches + a soft top-left specular. */}
                <circle className="mx-ring__notches" cx="500" cy="500" r={RING_RADIUS} />
                <circle className="mx-ring__spec" cx="500" cy="500" r={RING_RADIUS} strokeDasharray={`${RING_CIRCUMFERENCE * 0.18} ${RING_CIRCUMFERENCE}`} />
                <circle className="mx-ring__rim mx-ring__rim--outer" cx="500" cy="500" r={RING_RADIUS + 13} />
                <circle className="mx-ring__rim mx-ring__rim--inner" cx="500" cy="500" r={RING_RADIUS - 13} />
                {/* Decorative instrument ticks, barely-there, like the art. */}
                <circle className="mx-ring__ticks" cx="500" cy="500" r={RING_RADIUS - 34} />
                {/* A fine red accent ring tracing the inside of the bezel. */}
                <circle className="mx-ring__hairline" cx="500" cy="500" r={RING_RADIUS - 24} />
                {/* The art's micro-instrument details, 5 to 8 o'clock. */}
                <path className="mx-ring__dots" d={arcPath(RING_RADIUS - 54, 62, 148)} />
                <path className="mx-ring__dots mx-ring__dots--fine" d={arcPath(RING_RADIUS - 68, 76, 132)} />
                <path className="mx-ring__microarc" d={arcPath(RING_RADIUS - 46, 96, 112)} />
                {/* Tiny red highlights on the outermost outline — partial,
                    never a full lit circle. */}
                <path className="mx-ring__rimspark" d={arcPath(RING_RADIUS + 13, 198, 214)} />
                <path className="mx-ring__rimspark" d={arcPath(RING_RADIUS + 13, 22, 34)} />
                {/* The faint glass sheen across the upper face. */}
                <circle className="mx-ring__glass" cx="500" cy="500" r={RING_RADIUS - 14} fill="url(#mxRingGlass)" />
                {/* Elapsed time, accumulating ANTI-clockwise — the reverse
                    of the countdown — as a lit red tube: halo, body, core. */}
                <circle
                  className="mx-ring__arc mx-ring__halo"
                  cx="500"
                  cy="500"
                  r={RING_RADIUS}
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
                />
                <circle
                  className="mx-ring__arc mx-ring__fill"
                  cx="500"
                  cy="500"
                  r={RING_RADIUS}
                  stroke="url(#mxRingRed)"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
                />
                <circle
                  className="mx-ring__arc mx-ring__core"
                  cx="500"
                  cy="500"
                  r={RING_RADIUS}
                  stroke="url(#mxRingCore)"
                  strokeDasharray={RING_CIRCUMFERENCE}
                  strokeDashoffset={RING_CIRCUMFERENCE * (1 - progress / 100)}
                />
                <circle
                  className="mx-ring__arc mx-ring__edge"
                  cx="500"
                  cy="500"
                  r={RING_RADIUS + 9}
                  strokeDasharray={2 * Math.PI * (RING_RADIUS + 9)}
                  strokeDashoffset={2 * Math.PI * (RING_RADIUS + 9) * (1 - progress / 100)}
                />
                <circle
                  className="mx-ring__arc mx-ring__inshadow"
                  cx="500"
                  cy="500"
                  r={RING_RADIUS - 9}
                  strokeDasharray={2 * Math.PI * (RING_RADIUS - 9)}
                  strokeDashoffset={2 * Math.PI * (RING_RADIUS - 9) * (1 - progress / 100)}
                />
                {progress > 0.4 && progress < 99.8 ? (() => {
                  // The arc's leading tip, burning brighter — the lap hand,
                  // travelling anti-clockwise with the arc.
                  const headAngle = -Math.PI / 2 - (progress / 100) * 2 * Math.PI
                  const headX = 500 + RING_RADIUS * Math.cos(headAngle)
                  const headY = 500 + RING_RADIUS * Math.sin(headAngle)
                  return (
                    <>
                      <circle className="mx-ring__headglow" cx={headX} cy={headY} r="26" />
                      <circle className="mx-ring__head" cx={headX} cy={headY} r="10" />
                    </>
                  )
                })() : null}
              </svg>

              <div className="mx-face">
                <span className="mx-tag">Level</span>
                <span className="mx-levelno">{level?.level_no ?? "—"}</span>
                <span className={`mx-clock${urgent ? " mx-clock--urgent" : ""}`}>{countdown(remaining)}</span>
                <i className="mx-cut" aria-hidden="true" />
                <span className="mx-tag">{isBreak ? "Break" : "Blinds"}</span>
                <span className="mx-blinds">{blindLabel}</span>
                <span className="mx-tag mx-tag--next">Next Level</span>
                <span className="mx-nextblinds">{nextLabel}</span>
              </div>
            </div>
          </main>

          <aside className="mx-col mx-col--right">
            {/* Keyed by face: every 10s swap remounts, and the cascade
                animation announces the change like a broadcast graphic. */}
            {rail === "chips" || !hasPrizes ? (
              <div className="mx-railface" key="chips">
                <h3 className="mx-railhead">Chip Denominations</h3>
                <div className="mx-raillist">
                  {denominations.map((denom, index) => (
                    <div
                      key={denom}
                      className="mx-card mx-card--rail"
                      style={{ animationDelay: `${index * 45}ms` }}
                    >
                      <ChipIcon color={chipColor(denom)} />
                      <strong className="mx-card__value mx-card__value--rail">{denom}</strong>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mx-railface" key="prizes">
                <h3 className="mx-railhead">Prize Distribution</h3>
                <div className="mx-raillist">
                  {extras.prize_guarantee ? (
                    <div className="mx-card mx-card--rail mx-card--gtd">
                      <span className="mx-prize__place">GTD</span>
                      <strong className="mx-card__value mx-card__value--rail">{extras.prize_guarantee}</strong>
                    </div>
                  ) : null}
                  {prizeRows.map((row, index) => (
                    <div
                      key={index}
                      className="mx-card mx-card--rail"
                      style={{ animationDelay: `${(index + (extras.prize_guarantee ? 1 : 0)) * 45}ms` }}
                    >
                      <span className="mx-prize__place">{row.place}</span>
                      <strong className="mx-card__value mx-card__value--rail">{row.prize}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>

        <div
          className="mx-bottombar"
          onPointerEnter={holdBar}
          onPointerMove={holdBar}
          onPointerLeave={() => { if (barMode === "controls") armBarRevert() }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {barMode === "controls" ? (
            <div className="mx-bar mx-bar--controls" key="controls">
              {run ? (
                <button
                  type="button"
                  className={`mx-bbtn${run.go ? " mx-bbtn--go" : ""}`}
                  disabled={busy || !clock}
                  onClick={() => void control(run.action)}
                >
                  {run.label}
                </button>
              ) : (
                <span className="mx-bar__finished">Finished</span>
              )}
              <button
                type="button"
                className="mx-bbtn"
                disabled={busy || !canStep}
                onClick={() => void control("next")}
              >
                Next level
              </button>
              <button type="button" className="mx-bbtn mx-bbtn--ghost" onClick={() => void toggleMode()}>
                Minimise
              </button>
            </div>
          ) : (
            <div className="mx-bar mx-bar--info" key="info">
              {extras.addon_tiers.length > 0 ? (
                <span className="mx-bar__seg">
                  <em>Add-on</em>
                  {money(extras.addon_tiers[0].price_cents)} + {extras.addon_tiers[0].chips.toLocaleString()} chips
                </span>
              ) : null}
              {extras.rebuy_tiers.length > 0 ? (
                <span className="mx-bar__seg">
                  <em>Rebuy</em>
                  {money(extras.rebuy_tiers[0].price_cents)} + {extras.rebuy_tiers[0].chips.toLocaleString()} chips
                </span>
              ) : null}
              <span className="mx-bar__seg">
                <em>Total chips</em>
                {(summary.total_chips ?? 0).toLocaleString()}
              </span>
            </div>
          )}
        </div>

      </div>

      {error ? <p className="rc-stale">{error}</p> : null}
    </div>
  )
}
