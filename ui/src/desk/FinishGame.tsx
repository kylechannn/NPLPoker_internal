import { useRef, useState } from "react"
import { Loader2, ScanLine, Trophy, X } from "lucide-react"
import { deskApi } from "./deskApi"
import { notify } from "../notifications/store"
import "./host.css"

type Slot = { npl_id: string, display_name: string } | null

type Props = {
  sessionId: number
  onBack: () => void
  onFinished: () => void
}

/**
 * Step 4 — Finishing. Ten ranked slots; the staff scans each finisher into
 * their place (1st first), presses Finish game, and the page freezes while
 * the standings push to the NPL cloud. The confirmation popup only appears
 * once the cloud has answered.
 */
export default function FinishGame({ sessionId, onBack, onFinished }: Props) {
  const [slots, setSlots] = useState<Slot[]>(Array.from({ length: 10 }, () => null))
  const [inputs, setInputs] = useState<string[]>(Array.from({ length: 10 }, () => ""))
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [done, setDone] = useState<{ name: string, venue: string | null, pushed: boolean } | null>(null)
  const rowRefs = useRef<Array<HTMLInputElement | null>>([])

  async function resolveRow(index: number) {
    const raw = inputs[index].trim()
    if (!raw || busyRow !== null) return

    setBusyRow(index)
    setError(null)

    try {
      const result = await deskApi.scan(sessionId, raw)

      if (!result.entry) {
        throw new Error(`${result.player.display_name} is not in this tournament.`)
      }

      if (slots.some((slot, i) => i !== index && slot?.npl_id === result.player.npl_id)) {
        throw new Error(`${result.player.display_name} is already placed.`)
      }

      setSlots((current) => current.map((slot, i) => (i === index
        ? { npl_id: result.player.npl_id, display_name: result.player.display_name }
        : slot)))
      setInputs((current) => current.map((value, i) => (i === index ? "" : value)))

      // Straight on to the next empty rank — scan, scan, scan.
      const next = slots.findIndex((slot, i) => i > index && slot === null)
      window.setTimeout(() => rowRefs.current[next >= 0 ? next : index]?.focus(), 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : "That scan could not be read.")
    } finally {
      setBusyRow(null)
    }
  }

  const placedCount = slots.filter(Boolean).length

  async function finishGame() {
    if (placedCount === 0 || pushing) return

    setPushing(true)
    setError(null)

    try {
      const placements = slots
        .map((slot, index) => (slot ? { npl_id: slot.npl_id, position: index + 1 } : null))
        .filter((entry): entry is { npl_id: string, position: number } => entry !== null)

      const { result } = await deskApi.finalise(sessionId, placements)

      notify(
        "system",
        `${result.name} finished`,
        result.pushed
          ? `Top ${result.recorded} pushed to the NPL cloud.`
          : `Top ${result.recorded} recorded — standings queued, they sync when the link returns.`,
        result.pushed ? "success" : "warning",
      )
      setDone({ name: result.name, venue: result.venue_name, pushed: result.pushed })
    } catch (e) {
      setError(e instanceof Error ? e.message : "The game could not be finished.")
      setPushing(false)
    }
  }

  const ordinal = (n: number) => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`

  return (
    <div className="host-finish">
      <header className="host-finish__head">
        <div>
          <h3><Trophy size={18} /> Final standings</h3>
          <p>Scan each finisher into their rank — 1st place first. Empty ranks are fine.</p>
        </div>
        <button type="button" className="host-desk__exit" disabled={pushing} onClick={onBack}>Back to desk</button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}

      <ol className="host-finish__slots">
        {slots.map((slot, index) => (
          <li key={index} className={slot ? "host-finish__slot host-finish__slot--filled" : "host-finish__slot"}>
            <span className="host-finish__rank">{ordinal(index + 1)}</span>
            {slot ? (
              <>
                <strong>{slot.display_name}</strong>
                <small>{slot.npl_id}</small>
                <button
                  type="button"
                  aria-label={`Clear ${ordinal(index + 1)} place`}
                  disabled={pushing}
                  onClick={() => setSlots((current) => current.map((s, i) => (i === index ? null : s)))}
                >
                  <X size={14} />
                </button>
              </>
            ) : (
              <label>
                <ScanLine size={15} />
                <input
                  ref={(el) => { rowRefs.current[index] = el }}
                  value={inputs[index]}
                  placeholder="Scan card or type NPL ID…"
                  disabled={pushing || busyRow !== null}
                  onChange={(e) => setInputs((current) => current.map((value, i) => (i === index ? e.target.value : value)))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void resolveRow(index)
                    }
                  }}
                />
                {busyRow === index ? <Loader2 size={14} className="host-spin" /> : null}
              </label>
            )}
          </li>
        ))}
      </ol>

      <footer className="host-finish__footer">
        <span>{placedCount} of 10 placed</span>
        <button
          type="button"
          className="host-finish__submit"
          disabled={placedCount === 0 || pushing}
          onClick={() => setConfirming(true)}
        >
          {pushing ? "Pushing to the NPL cloud…" : "Finish game"}
        </button>
      </footer>

      {confirming ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => setConfirming(false)}>
          <section className="host-scan-modal__panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="host-finish__confirm-title">Finish this game?</h3>
            <p className="host-finish__confirm-copy">
              The top {placedCount} placement{placedCount === 1 ? "" : "s"} will be recorded and pushed to the
              NPL cloud, and the session will be marked <strong>finished</strong>. Once finished there is
              <strong> no turning back</strong> — check the ranks one more time.
            </p>
            <footer className="host-scan-modal__footer">
              <span className="host-scan-modal__total" />
              <button type="button" className="host-scan-modal__cancel" onClick={() => setConfirming(false)}>
                Not yet
              </button>
              <button
                type="button"
                className="host-scan-modal__submit"
                onClick={() => {
                  setConfirming(false)
                  void finishGame()
                }}
              >
                Finish — no turning back
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {pushing && !done ? (
        <div className="host-finish__overlay" role="alert" aria-busy="true">
          <Loader2 size={34} className="host-spin" />
          <strong>Finishing the game…</strong>
          <small>Recording standings and pushing them to the NPL cloud. Please wait.</small>
        </div>
      ) : null}

      {done ? (
        <div className="host-finish__overlay">
          <Trophy size={34} />
          <strong>
            {new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
            {done.venue ? ` — ${done.venue}` : ""} — FINISHED
          </strong>
          <small>
            {done.name}. {done.pushed
              ? "Standings are live on the NPL cloud."
              : "Standings recorded locally — they will sync as soon as the backend link returns."}
          </small>
          <button type="button" className="host-finish__submit" onClick={onFinished}>Done</button>
        </div>
      ) : null}
    </div>
  )
}
