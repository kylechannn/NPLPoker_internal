import { useEffect, useRef, useState } from "react"
import { Copy, Minus, Square, X } from "lucide-react"
import { countdown, deskApi, type AddonTier, type Gates, type PrizeBreakdownRow, type Seating } from "./deskApi"
import { wheelApi } from "../jackpot/wheelApi"
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
  } | null
}

type Summary = {
  total_players?: number
  active_players?: number
  entries?: number
  total_chips?: number
  average_stack?: number
}

type DisplayExtras = {
  /** The linked cloud game's payout ladder — never typed at the desk. */
  prize_breakdown: PrizeBreakdownRow[] | null
  prize_guarantee: string | null
  /** Configured price/chip tiers — what the room clock shows, not a running count. */
  rebuy_tiers: AddonTier[]
  addon_tiers: AddonTier[]
  buy_in: AddonTier
}

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

/** Cents → dollar text, no decimals unless the amount needs them. */
function money(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** One line per configured tier — "Add on $20 - 20,000 chips" — not a count. */
function tierRows(tiers: AddonTier[], noun: string) {
  if (tiers.length === 0) return "—"
  return tiers.map((tier, index) => (
    <div key={index}>{noun} {money(tier.price_cents)} - {tier.chips.toLocaleString()} chips</div>
  ))
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
  const [extras, setExtras] = useState<DisplayExtras>({ prize_breakdown: null, prize_guarantee: null, rebuy_tiers: [], addon_tiers: [], buy_in: { price_cents: 0, chips: 0 } })
  const [gates, setGates] = useState<Gates | null>(null)
  const [syncedAt, setSyncedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState<string | null>(null)
  // The window opens as the mini widget (the Go host sizes it to match)
  // and grows to the projector display on demand.
  const [mode, setMode] = useState<"max" | "mini">("mini")
  // Sichuan's Zoom: hide everything but blind + time, oversized.
  const [zoomed, setZoomed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  // Level-change cue, the way the mahjong room clock announces a new
  // round: a short flash and a two-tone chime.
  const [levelFlash, setLevelFlash] = useState(false)
  const prevLevelRef = useRef<number | null>(null)
  // The live jackpot pool, worn as the gold crown of the big display.
  // Null (offline / no jackpot running) simply hides the badge.
  const [jackpotCents, setJackpotCents] = useState<number | null>(null)

  useEffect(() => {
    document.title = WINDOW_TITLE
  }, [])

  useEffect(() => {
    if (mode !== "max") setZoomed(false)
  }, [mode])

  // The pool figure moves slowly (the host caches it a minute anyway), so
  // one refresh a minute keeps the badge honest without touching the 5s
  // clock sync.
  useEffect(() => {
    let cancelled = false

    async function pullPool() {
      try {
        const { pool } = await wheelApi.pool()
        if (!cancelled) setJackpotCents(pool?.amount_cents ?? null)
      } catch {
        if (!cancelled) setJackpotCents(null)
      }
    }

    void pullPool()
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") void pullPool()
    }, 60_000)

    return () => {
      cancelled = true
      window.clearInterval(handle)
    }
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
          entries: seating.counts.entries,
          total_chips: seating.counts.total_chips,
          average_stack: seating.counts.average_stack,
        })
        setExtras({
          prize_breakdown: seating.display?.prize_breakdown ?? null,
          prize_guarantee: seating.display?.prize_guarantee ?? null,
          rebuy_tiers: seating.rebuy_tiers ?? [],
          addon_tiers: seating.addon_tiers ?? [],
          buy_in: seating.buy_in ?? { price_cents: 0, chips: 0 },
        })
        setGates(seating.gates)
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
    : `${(level?.small_blind ?? 0).toLocaleString()} / ${(level?.big_blind ?? 0).toLocaleString()}`
  const nextLabel = clock?.next_level
    ? (clock.next_level.is_break
        ? (clock.next_level.note || "Break")
        : `${clock.next_level.small_blind.toLocaleString()} / ${clock.next_level.big_blind.toLocaleString()}`)
    : "Final level"

  const tone = paused ? "paused" : isBreak ? "break" : clock?.running ? "live" : "idle"

  const jackpotLabel = jackpotCents !== null ? money(jackpotCents) : null

  // Players remaining against total entries, the way the room reads it:
  // 50/65 — everyone still in versus everyone who bought a seat.
  const playersLabel = summary.active_players !== undefined && summary.entries !== undefined
    ? `${summary.active_players.toLocaleString()}/${summary.entries.toLocaleString()}`
    : summary.active_players?.toLocaleString() ?? "—"

  const nextBreak = clock?.next_break ?? null
  const nextBreakLabel = nextBreak
    ? (nextBreak.on_break ? "Now" : countdown(Math.max(0, nextBreak.in_ms - (clock?.running ? elapsed : 0))))
    : null

  const prizeRows = extras.prize_breakdown ?? []
  const hasSidePanel = prizeRows.length > 0

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

  return (
    <div className={`rc rc--sichuan${levelFlash ? " rc--flash" : ""}`}>
      {titlebar}

      <div className="scx-page">
        <div className="scx-stage">
          <div className="scx-bg" aria-hidden="true" />
          <div className="scx-scrim" aria-hidden="true" />

          <div className="scx-content">
            <div className="scx-head">
              <div className="scx-head__side">
                <div className="scx-title">{clock?.name ?? "Tournament"}</div>
                <span className="scx-chip">Level {level?.level_no ?? "—"} / {clock?.level_count ?? "—"}</span>
              </div>
              {jackpotLabel ? (
                <div className="scx-jackpot" role="status">
                  <span className="scx-jackpot__label">Jackpot</span>
                  <span className="scx-jackpot__amount">{jackpotLabel}</span>
                </div>
              ) : null}
              <div className="scx-head__side scx-head__side--end">
                <span className="scx-chip">Next: {nextLabel}</span>
                {run ? (
                  <button
                    type="button"
                    className={`scx-run${run.go ? " scx-run--go" : ""}`}
                    disabled={busy || !clock}
                    onClick={() => void control(run.action)}
                  >
                    {run.label}
                  </button>
                ) : (
                  <span className="scx-chip">Finished</span>
                )}
              </div>
            </div>

            <div className={`scx-center${hasSidePanel && !zoomed ? " scx-center--rail" : ""}`}>
              <div className="scx-main">
              <div className={`scx-panel${zoomed ? " scx-panel--zoomed" : ""}`}>
                <button
                  type="button"
                  className="scx-zoom"
                  title={zoomed ? "Back to the normal full timer" : "Zoom blind and timer"}
                  onClick={() => setZoomed((z) => !z)}
                >
                  {zoomed ? "Unzoom" : "Zoom"}
                </button>

                <div className="scx-plabel">Current Blind</div>
                <div className="scx-blind">{blindLabel}</div>
                <div className="scx-meta">
                  Level {level?.level_no ?? "—"} / {clock?.level_count ?? "—"}
                  {!isBreak && level && level.bb_ante > 0 ? ` · Ante ${level.bb_ante.toLocaleString()}` : ""}
                </div>
                <div className="scx-plabel scx-plabel--gap">Time Remaining</div>
                <div className={`scx-clock${urgent ? " scx-clock--urgent" : ""}`}>{countdown(remaining)}</div>
                <div className="scx-progress" aria-hidden="true">
                  <span className={urgent ? "scx-progress--urgent" : undefined} style={{ transform: `scaleX(${progress / 100})` }} />
                </div>
                {paused ? (
                  <div className="scx-warn"><i />Paused</div>
                ) : urgent ? (
                  <div className="scx-warn"><i />Less than 60 seconds</div>
                ) : null}
              </div>

              {!zoomed ? (
                <div className="scx-panel scx-panel--next">
                  <div className="scx-plabel">Next</div>
                  <div className="scx-next">{nextLabel}</div>
                  {canStep ? (
                    <div className="scx-nav">
                      <button type="button" disabled={busy} onClick={() => void control("prev")}>Prev</button>
                      <button type="button" disabled={busy} onClick={() => void control("next")}>Next</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              </div>

              {!zoomed && hasSidePanel ? (
                <aside className="scx-panel scx-panel--side">
                  <div className="scx-side__body">
                    <div className="scx-plabel">Prizes</div>
                    {/* The linked game's ladder — Daily Games admin via
                        Manual Update. Guaranteed on top, then one row per
                        place. Read-only here. */}
                    {extras.prize_guarantee ? (
                      <div className="scx-payout-gtd">
                        <span>Guaranteed</span>
                        <strong>{extras.prize_guarantee}</strong>
                      </div>
                    ) : null}
                    <ul className="scx-payout">
                      {prizeRows.map((row, index) => (
                        <li key={index}>
                          <span className="scx-payout__place">{row.place}</span>
                          <span className="scx-payout__prize">{row.prize}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </aside>
              ) : null}
            </div>

            <div className="scx-stats">
              <div className="scx-stat">
                <div className="scx-stat__label">Buy In</div>
                <div className="scx-stat__value scx-stat__value--tiers">{tierRows([extras.buy_in], "Buy In")}</div>
              </div>
              <div className="scx-stat">
                <div className="scx-stat__label">Players</div>
                <div className="scx-stat__value">{playersLabel}</div>
              </div>
              <div className="scx-stat">
                <div className="scx-stat__label">Avg Stack</div>
                <div className="scx-stat__value">{summary.average_stack ? summary.average_stack.toLocaleString() : "—"}</div>
              </div>
              <div className="scx-stat">
                <div className="scx-stat__label">Total Chips</div>
                <div className="scx-stat__value">{summary.total_chips ? summary.total_chips.toLocaleString() : "—"}</div>
              </div>
              <div className="scx-stat">
                <div className="scx-stat__label">Rebuys</div>
                <div className="scx-stat__value scx-stat__value--tiers">{tierRows(extras.rebuy_tiers, "Rebuy")}</div>
              </div>
              <div className="scx-stat">
                <div className="scx-stat__label">Add-ons</div>
                <div className="scx-stat__value scx-stat__value--tiers">{tierRows(extras.addon_tiers, "Add on")}</div>
              </div>
              {nextBreakLabel ? (
                <div className="scx-stat">
                  <div className="scx-stat__label">Next Break</div>
                  <div className="scx-stat__value">{nextBreakLabel}</div>
                </div>
              ) : null}
              {gates?.registration.open && gates.registration.closes_in_ms !== null ? (
                <div className="scx-stat">
                  <div className="scx-stat__label">Reg Closes</div>
                  <div className="scx-stat__value">{countdown(Math.max(0, gates.registration.closes_in_ms - (clock?.running ? elapsed : 0)))}</div>
                </div>
              ) : gates && !gates.registration.open ? (
                <div className="scx-stat">
                  <div className="scx-stat__label">Registration</div>
                  <div className="scx-stat__value">Closed</div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {error ? <p className="rc-stale">{error}</p> : null}
    </div>
  )
}
