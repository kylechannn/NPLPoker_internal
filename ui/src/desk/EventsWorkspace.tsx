import { useState } from "react"
import { CircleDollarSign, Trophy, X } from "lucide-react"
import FinishGame from "./FinishGame"
import HostDesk from "./HostDesk"
import SessionsHub from "./SessionsHub"
import { HOST_STEPS } from "./HostWorkspace"
import { useOpenDesk, type DeskMode } from "./openDesk"
import type { Venue } from "./deskApi"
import "./host.css"

/**
 * The Events tab: Special Events and Main Event flights for this venue,
 * hosted with the same desks as any other night — except the operator
 * chooses, per event, how the room runs: tournament style (the clock,
 * blind ladder, buy-in cut-offs) or cash style (free flow, no clock).
 * The choice is made at "Open desk" and the desk opens straight into
 * registration on that kind's game structure defaults; resuming an open
 * desk re-enters whichever mode the event was opened with.
 */
export default function EventsWorkspace({ venue }: { venue: Venue | null }) {
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [deskMode, setDeskMode] = useState<DeskMode>("tournament")
  const [stage, setStage] = useState<"desk" | "finish">("desk")
  const [clockStatus, setClockStatus] = useState<string>("draft")
  // The event awaiting its mode choice — the picker is open while set.
  const [choosing, setChoosing] = useState<number | null>(null)

  const opener = useOpenDesk(venue, (id) => {
    setSessionId(id)
    setStage("desk")
  })

  const pickMode = (mode: DeskMode) => {
    const gameSessionId = choosing
    setChoosing(null)
    setDeskMode(mode)
    void opener.open(mode, gameSessionId)
  }

  if (sessionId === null) {
    return (
      <>
        {opener.error ? <p className="host-desk__error" role="alert">{opener.error}</p> : null}
        <SessionsHub
          venue={venue}
          mode="events"
          opening={opener.opening}
          onOpenLocal={(localTournamentId, gameType) => {
            setDeskMode(gameType === "cash" ? "cash" : "tournament")
            setSessionId(localTournamentId)
            setStage("desk")
          }}
          onOpen={(gameSessionId) => setChoosing(gameSessionId)}
        />
        {opener.dialog}

        {choosing !== null ? (
          <div className="host-scan-modal" role="presentation" onMouseDown={() => setChoosing(null)}>
            <section
              className="host-scan-modal__panel host-mode-pick"
              role="dialog"
              aria-modal="true"
              aria-label="Choose how this event runs"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <header className="host-mode-pick__head">
                <h3>How does this event run?</h3>
                <button type="button" aria-label="Cancel" onClick={() => setChoosing(null)}>
                  <X size={16} />
                </button>
              </header>

              <div className="host-mode-pick__options">
                <button type="button" className="host-mode-pick__option" onClick={() => pickMode("tournament")}>
                  <Trophy size={22} />
                  <strong>Tournament mode</strong>
                  <span>The daily-game desk: level clock, blind ladder, buy-in / rebuy / add-on cut-offs — on the tournament defaults.</span>
                </button>

                <button type="button" className="host-mode-pick__option" onClick={() => pickMode("cash")}>
                  <CircleDollarSign size={22} />
                  <strong>Cash game mode</strong>
                  <span>The free-flow desk: no clock or cut-offs — buy-ins and top-ups stay open all night, on the cash defaults.</span>
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </>
    )
  }

  const currentStep = stage === "finish" ? 2 : clockStatus === "running" || clockStatus === "paused" ? 1 : 0

  return (
    <div className="host-staged">
      <div className="prep-steps host-staged__steps">
        {HOST_STEPS.map((step, index) => {
          const active = index === currentStep
          const completed = index < currentStep

          return (
            <button
              key={step.id}
              type="button"
              className="prep-steps__item"
              onClick={() => {
                if (step.id === "finish") setStage("finish")
                else setStage("desk")
              }}
            >
              <div
                className={[
                  "prep-steps__dot",
                  completed ? "prep-steps__dot--done" : active ? "prep-steps__dot--active" : "",
                ].filter(Boolean).join(" ")}
              >
                {index + 1}
              </div>
              <div className="prep-steps__label">{step.label}</div>
            </button>
          )
        })}
      </div>

      <div className="prep-progress host-staged__progress">
        <div className="prep-progress__track">
          <div className="prep-progress__fill" style={{ width: `${((currentStep + 1) / HOST_STEPS.length) * 100}%` }} />
        </div>
        <div className="prep-progress__meta">
          <span>{HOST_STEPS[currentStep].label}</span>
          <span>Step {currentStep + 1} of {HOST_STEPS.length}</span>
        </div>
      </div>

      {stage === "finish" ? (
        <FinishGame
          sessionId={sessionId}
          mode={deskMode}
          onBack={() => setStage("desk")}
          onFinished={() => {
            setStage("desk")
            setSessionId(null)
          }}
        />
      ) : (
        <HostDesk
          sessionId={sessionId}
          mode={deskMode}
          onExit={() => setSessionId(null)}
          onClockStatus={setClockStatus}
          onFinishGame={() => setStage("finish")}
        />
      )}
    </div>
  )
}
