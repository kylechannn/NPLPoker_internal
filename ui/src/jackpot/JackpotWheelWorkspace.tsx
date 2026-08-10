// Self-hosted copies of the fonts the frontend wheel loads from Google Fonts
// (same families and weights), so the wheel renders identically offline.
// This is an English-only desk tool — the "latin-" entrypoints skip the
// cyrillic/greek/vietnamese/etc. subsets the default imports bundle for
// every weight, which cut this page's font weight from ~1.4MB to a
// fraction of that.
import "@fontsource/chakra-petch/latin-500.css"
import "@fontsource/chakra-petch/latin-600.css"
import "@fontsource/chakra-petch/latin-700.css"
import "@fontsource/jetbrains-mono/latin-500.css"
import "@fontsource/jetbrains-mono/latin-600.css"
import "@fontsource/jetbrains-mono/latin-700.css"
import "@fontsource/jetbrains-mono/latin-800.css"
import "@fontsource/inter/latin-400.css"
import "@fontsource/inter/latin-500.css"
import "@fontsource/inter/latin-600.css"
import "@fontsource/inter/latin-700.css"
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react"
import { ScanLine, RefreshCw, ShieldCheck, Undo2 } from "lucide-react"
import PrizeWheel, { type SpinOutcome } from "./PrizeWheel"
import { toWheelPrizes, wheelApi, type WheelEligibility, type WheelPlayer, type WheelSegment, type WheelTier } from "./wheelApi"
import { hueGradients, type WheelPrize } from "./wheelPrizes"
import "./jackpot-wheel.css"

/** The odds legend beside the wheel: every prize, its chance, and a bar
 *  coloured to match that prize's wedge — biggest chance first. */
function WheelOddsList({ prizes, golden }: { prizes: WheelPrize[], golden: boolean }) {
  const sorted = [...prizes].sort((a, b) => b.weight - a.weight)
  const maxWeight = Math.max(1, ...prizes.map((prize) => prize.weight))

  return (
    <aside className={golden ? "wheel-odds wheel-odds--golden" : "wheel-odds"} aria-label="Wheel odds">
      <p className="wheel-odds__title">Odds</p>
      <ul className="wheel-odds__list">
        {sorted.map((prize) => (
          <li key={prize.id} className="wheel-odds__row">
            <div className="wheel-odds__label">
              <span>{prize.prize}</span>
              <strong>{prize.weight}%</strong>
            </div>
            <div className="wheel-odds__bar" aria-hidden="true">
              <i style={{ "--odds": `${(prize.weight / maxWeight) * 100}%`, "--odds-color": hueGradients[prize.hue][0] } as CSSProperties} />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * The Jackpot Wheel tab: scan the player first — exactly like registration —
 * then the wheel opens. Only this desk spins for real: the cloud draws the
 * winner and the prize lands in the player's inbox automatically.
 *
 * Landing on the golden segment does not end the turn: the stage flips to
 * the all-golden wheel and the SAME player draws again — that second draw
 * is the prize that pays (and what comes off the jackpot).
 */
export default function JackpotWheelWorkspace() {
  const [segments, setSegments] = useState<WheelSegment[] | null>(null)
  const [goldenSegments, setGoldenSegments] = useState<WheelSegment[]>([])
  const [segmentsError, setSegmentsError] = useState(false)
  const [scanValue, setScanValue] = useState("")
  const [scanBusy, setScanBusy] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [player, setPlayer] = useState<WheelPlayer | null>(null)
  const [eligibility, setEligibility] = useState<WheelEligibility>(null)
  const [spinError, setSpinError] = useState<string | null>(null)
  // Which tier the stage is showing; golden carries the funding spin's ref.
  const [activeWheel, setActiveWheel] = useState<WheelTier>("normal")
  const [goldenParentRef, setGoldenParentRef] = useState<string | null>(null)
  // The unlock take-over: gold burst + title before the golden wheel shows.
  const [goldenIntro, setGoldenIntro] = useState(false)
  const goldenIntroTimerRef = useRef<number>(0)
  // The completed draw — once set, the bottom card flips to the reward
  // summary and the Done button, which is the only way off the page.
  const [outcome, setOutcome] = useState<SpinOutcome | null>(null)
  // A spin's reference survives a failed attempt so the retry can never
  // double-award — the cloud treats the same reference as the same spin.
  const referenceRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    wheelApi.segments()
      .then((result) => {
        if (!cancelled) setSegments(result.segments)
      })
      .catch(() => {
        if (!cancelled) setSegmentsError(true)
      })
    wheelApi.segments("golden")
      .then((result) => {
        if (!cancelled) setGoldenSegments(result.segments)
      })
      .catch(() => {
        // The golden wheel is optional — a miss only matters if a spin
        // actually lands on the golden segment, and the cloud gates that.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => () => window.clearTimeout(goldenIntroTimerRef.current), [])

  /** Take over the screen with the gold burst, then reveal the golden wheel. */
  function playGoldenIntro() {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    setGoldenIntro(true)
    window.clearTimeout(goldenIntroTimerRef.current)
    goldenIntroTimerRef.current = window.setTimeout(() => setGoldenIntro(false), reduced ? 1200 : 3000)
  }

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nplId = scanValue.trim().toUpperCase()
    if (!nplId || scanBusy) return

    setScanBusy(true)
    setScanError(null)
    try {
      const result = await wheelApi.lookup(nplId)

      // A golden draw won earlier but never taken (crash, closed app)
      // resumes first — it is already paid for, eligibility or not.
      const pendingGolden = result.eligibility?.pending_golden?.[0] ?? null

      // The cloud gate speaks before the wheel opens: an ineligible player
      // stays on the scan page with the reason on screen.
      if (!pendingGolden && result.eligibility && !result.eligibility.eligible) {
        setScanError(result.eligibility.reason ?? "This player cannot spin right now.")
        return
      }

      setPlayer(result.player)
      setEligibility(result.eligibility)
      setActiveWheel(pendingGolden ? "golden" : "normal")
      setGoldenParentRef(pendingGolden ? pendingGolden.parent_reference : null)
      if (pendingGolden) playGoldenIntro()
      setScanValue("")
      setSpinError(null)
      referenceRef.current = null
    } catch (error) {
      setScanError(error instanceof Error ? error.message : "The player could not be found.")
    } finally {
      setScanBusy(false)
    }
  }

  function resetToScan() {
    setPlayer(null)
    setEligibility(null)
    setScanError(null)
    setSpinError(null)
    setOutcome(null)
    setActiveWheel("normal")
    setGoldenParentRef(null)
    setGoldenIntro(false)
    window.clearTimeout(goldenIntroTimerRef.current)
    referenceRef.current = null
  }

  async function requestSpin(): Promise<SpinOutcome | null> {
    if (!player) return null
    // One draw per scan — a settled outcome means the wheel is done
    // (the golden follow-up runs on a freshly-mounted, unlocked wheel).
    if (outcome !== null) return null

    setSpinError(null)
    referenceRef.current ??= `WS-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`
    const storedVenue = window.localStorage.getItem("npl.activeVenueId")
    const venueId = storedVenue ? Number(storedVenue) || null : null

    try {
      const { spin } = await wheelApi.spin(
        referenceRef.current,
        player.npl_id,
        venueId,
        activeWheel === "golden" && goldenParentRef
          ? { wheel: "golden", parentReference: goldenParentRef }
          : undefined,
      )
      referenceRef.current = null

      // Don't reveal here — the wheel is still spinning. The card flips
      // when PrizeWheel reports the rotor has landed (onSettled).
      return {
        segmentIndex: spin.segment_index,
        prizeLabel: spin.prize.label,
        voucherCode: spin.voucher?.code ?? null,
        voucherExpiresAt: spin.voucher?.expires_at ?? null,
        pointsAmount: spin.points_amount,
        playerName: spin.player.display_name,
        reference: spin.reference ?? null,
        followUp: spin.follow_up === "golden_wheel" ? "golden_wheel" : null,
      }
    } catch (error) {
      // Keep the reference: pressing SPIN again retries the SAME spin.
      setSpinError(error instanceof Error ? error.message : "The spin could not be completed. Nothing was drawn.")
      return null
    }
  }

  /**
   * The rotor landed. A golden-segment hit flips the stage to the golden
   * wheel instead of finishing — the follow-up draw is the real prize.
   */
  function handleSettled(settled: SpinOutcome) {
    if (settled.followUp === "golden_wheel" && settled.reference) {
      setActiveWheel("golden")
      setGoldenParentRef(settled.reference)
      setSpinError(null)
      referenceRef.current = null
      playGoldenIntro()
      return
    }
    setOutcome(settled)
  }

  if (!player) {
    return (
      <div className="jackpot-wheel-view">
        <section className="wheel-scan-card" aria-labelledby="wheel-scan-heading">
          <span className="wheel-scan-card__icon"><ScanLine size={26} /></span>
          <p className="wheel-scan-card__kicker">Jackpot Wheel</p>
          <h1 id="wheel-scan-heading">Scan the player to spin</h1>
          <p className="wheel-scan-card__lead">
            Scan their club card or enter the NPL ID — same as registration. The wheel opens once the player is identified.
          </p>

          <form className="wheel-scan-card__form" onSubmit={(event) => void submitScan(event)}>
            <input
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value.toUpperCase())}
              placeholder="Scan member card or type NPL ID…"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              aria-label="Player NPL ID"
            />
            <button type="submit" disabled={scanBusy || !scanValue.trim()}>
              {scanBusy ? <RefreshCw size={17} className="wheel-scan-card__spin" /> : <ScanLine size={17} />}
              {scanBusy ? "Finding…" : "Open the wheel"}
            </button>
          </form>

          {scanError ? <p className="wheel-scan-card__error" role="alert">{scanError}</p> : null}

          {segmentsError ? (
            <p className="wheel-scan-card__note">The wheel composition could not be read — run a Manual update.</p>
          ) : segments !== null && segments.length === 0 ? (
            <p className="wheel-scan-card__note">
              The wheel has no prizes yet. Compose it in the admin console (Jackpot Control), then run a Manual update here.
            </p>
          ) : (
            <p className="wheel-scan-card__foot">
              <ShieldCheck size={14} />
              The cloud draws the winner — the prize is sent to the player's inbox automatically.
            </p>
          )}
        </section>
      </div>
    )
  }

  // The golden face alternates two gold tones so its all-gold segments
  // still read as separate prizes.
  const goldenPrizes: WheelPrize[] = toWheelPrizes(goldenSegments).map((prize, index) => ({
    ...prize,
    hue: index % 2 === 0 ? "gold" : "goldDeep",
  }))
  const prizes = activeWheel === "golden" ? goldenPrizes : toWheelPrizes(segments ?? [])
  const isGolden = activeWheel === "golden"

  // Scanned → the wheel takes the whole window. The player rides as a card
  // at the bottom middle; after the draw the card flips to the reward and
  // Done is the only exit — it clears everything back to the scan input.
  return (
    <div
      className={isGolden ? "wheel-fullscreen wheel-fullscreen--golden" : "wheel-fullscreen"}
      role="dialog"
      aria-modal="true"
      aria-label={`${isGolden ? "Golden Wheel" : "Jackpot Wheel"} — ${player.display_name}`}
    >
      {outcome === null && !isGolden ? (
        <button type="button" className="wheel-fullscreen__leave" onClick={resetToScan}>
          <Undo2 size={15} /> Change player
        </button>
      ) : null}

      {isGolden && outcome === null && !goldenIntro ? (
        <p className="wheel-golden-banner" role="status">✨ GOLDEN WHEEL — one more spin, {player.display_name}! ✨</p>
      ) : null}

      {goldenIntro ? (
        <div className="wheel-golden-intro" role="status" aria-label="Golden wheel unlocked">
          <div className="wheel-golden-intro__rays" aria-hidden="true" />
          <div className="wheel-golden-intro__flash" aria-hidden="true" />
          <div className="wheel-golden-intro__sparks" aria-hidden="true">
            {Array.from({ length: 14 }, (_, index) => (
              <i key={index} style={{ "--i": index } as CSSProperties} />
            ))}
          </div>
          <div className="wheel-golden-intro__text">
            <span className="wheel-golden-intro__eyebrow">{player.display_name} hit the golden segment</span>
            <strong className="wheel-golden-intro__title">GOLDEN WHEEL</strong>
            <span className="wheel-golden-intro__sub">✨ UNLOCKED — SPIN AGAIN ✨</span>
          </div>
        </div>
      ) : null}

      <div className="wheel-fullscreen__stage">
        {prizes.length === 0 ? (
          <section className="wheel-scan-card">
            <p className="wheel-scan-card__note">
              {isGolden
                ? "The golden wheel has no prizes on this machine yet — run a Manual update, then scan the player again to take the golden spin."
                : "The wheel has no prizes yet. Compose it in the admin console (Jackpot Control), then run a Manual update here."}
            </p>
          </section>
        ) : (
          <>
            <PrizeWheel key={activeWheel} prizes={prizes} golden={isGolden} locked={outcome !== null} requestSpin={requestSpin} onSettled={handleSettled} />
            <WheelOddsList prizes={prizes} golden={isGolden} />
          </>
        )}
      </div>

      {spinError ? <p className="wheel-spin-error" role="alert">{spinError}</p> : null}

      <div className={outcome ? "wheel-player-card wheel-player-card--won" : "wheel-player-card"}>
        {player.avatar_media_key ? (
          <img className="wheel-player-card__avatar" src={`/media/${player.avatar_media_key}`} alt="" />
        ) : (
          <span className="wheel-player-card__avatar wheel-player-card__avatar--initials">
            {player.display_name.slice(0, 2).toUpperCase()}
          </span>
        )}

        <div className="wheel-player-card__info">
          <strong>{player.display_name}</strong>
          <span>
            {player.npl_id}
            {player.state_code ? ` · ${player.state_code}` : ""}
          </span>
          {outcome === null ? (
            isGolden ? (
              <em className="wheel-player-card__golden">✨ Golden spin ready — this one pays</em>
            ) : eligibility?.mode === "jackpot_entry" && eligibility.spins_available !== null ? (
              <em>{eligibility.spins_available} spin{eligibility.spins_available === 1 ? "" : "s"} available</em>
            ) : (
              <em>Ready to spin</em>
            )
          ) : (
            <em className="wheel-player-card__prize">
              🏆 {outcome.prizeLabel}
              {outcome.voucherCode ? ` — voucher ${outcome.voucherCode}` : ""}
              {outcome.pointsAmount ? ` — ${outcome.pointsAmount.toLocaleString()} points` : ""}
              {" · sent to their inbox"}
            </em>
          )}
        </div>

        {outcome !== null ? (
          <button type="button" className="wheel-player-card__done" onClick={resetToScan}>
            Done
          </button>
        ) : null}
      </div>
    </div>
  )
}
