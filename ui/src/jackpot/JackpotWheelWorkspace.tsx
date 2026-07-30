// Self-hosted copies of the fonts the frontend wheel loads from Google Fonts
// (same families and weights), so the wheel renders identically offline.
import "@fontsource/chakra-petch/500.css"
import "@fontsource/chakra-petch/600.css"
import "@fontsource/chakra-petch/700.css"
import "@fontsource/jetbrains-mono/500.css"
import "@fontsource/jetbrains-mono/600.css"
import "@fontsource/jetbrains-mono/700.css"
import "@fontsource/jetbrains-mono/800.css"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/inter/700.css"
import { useEffect, useRef, useState, type FormEvent } from "react"
import { ScanLine, RefreshCw, ShieldCheck, Undo2 } from "lucide-react"
import PrizeWheel, { type SpinOutcome } from "./PrizeWheel"
import { toWheelPrizes, wheelApi, type WheelEligibility, type WheelPlayer, type WheelSegment } from "./wheelApi"
import "./jackpot-wheel.css"

/**
 * The Jackpot Wheel tab: scan the player first — exactly like registration —
 * then the wheel opens. Only this desk spins for real: the cloud draws the
 * winner and the prize lands in the player's inbox automatically.
 */
export default function JackpotWheelWorkspace() {
  const [segments, setSegments] = useState<WheelSegment[] | null>(null)
  const [segmentsError, setSegmentsError] = useState(false)
  const [scanValue, setScanValue] = useState("")
  const [scanBusy, setScanBusy] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [player, setPlayer] = useState<WheelPlayer | null>(null)
  const [eligibility, setEligibility] = useState<WheelEligibility>(null)
  const [spinError, setSpinError] = useState<string | null>(null)
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
    return () => {
      cancelled = true
    }
  }, [])

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nplId = scanValue.trim().toUpperCase()
    if (!nplId || scanBusy) return

    setScanBusy(true)
    setScanError(null)
    try {
      const result = await wheelApi.lookup(nplId)

      // The cloud gate speaks before the wheel opens: an ineligible player
      // stays on the scan page with the reason on screen.
      if (result.eligibility && !result.eligibility.eligible) {
        setScanError(result.eligibility.reason ?? "This player cannot spin right now.")
        return
      }

      setPlayer(result.player)
      setEligibility(result.eligibility)
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
    referenceRef.current = null
  }

  async function requestSpin(): Promise<SpinOutcome | null> {
    if (!player) return null

    setSpinError(null)
    referenceRef.current ??= `WS-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`
    const storedVenue = window.localStorage.getItem("npl.activeVenueId")
    const venueId = storedVenue ? Number(storedVenue) || null : null

    try {
      const { spin } = await wheelApi.spin(referenceRef.current, player.npl_id, venueId)
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
      }
    } catch (error) {
      // Keep the reference: pressing SPIN again retries the SAME spin.
      setSpinError(error instanceof Error ? error.message : "The spin could not be completed. Nothing was drawn.")
      return null
    }
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

  const prizes = toWheelPrizes(segments ?? [])

  // Scanned → the wheel takes the whole window. The player rides as a card
  // at the bottom middle; after the draw the card flips to the reward and
  // Done is the only exit — it clears everything back to the scan input.
  return (
    <div className="wheel-fullscreen" role="dialog" aria-modal="true" aria-label={`Jackpot Wheel — ${player.display_name}`}>
      {outcome === null ? (
        <button type="button" className="wheel-fullscreen__leave" onClick={resetToScan}>
          <Undo2 size={15} /> Change player
        </button>
      ) : null}

      <div className="wheel-fullscreen__stage">
        {prizes.length === 0 ? (
          <section className="wheel-scan-card">
            <p className="wheel-scan-card__note">
              The wheel has no prizes yet. Compose it in the admin console (Jackpot Control), then run a Manual update here.
            </p>
          </section>
        ) : (
          <PrizeWheel prizes={prizes} requestSpin={requestSpin} onSettled={setOutcome} />
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
            eligibility?.mode === "jackpot_entry" && eligibility.spins_available !== null ? (
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
