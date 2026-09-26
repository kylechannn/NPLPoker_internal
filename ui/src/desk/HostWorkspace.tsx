import { useState } from "react"
import FinishGame from "./FinishGame"
import HostDesk from "./HostDesk"
import SessionsHub from "./SessionsHub"
import { useOpenDesk } from "./openDesk"
import type { Venue } from "./deskApi"
import "./host.css"

/**
 * The Tournament tab, staged: the Sessions hub is the front door (tonight's
 * cloud sessions with live counts). Open desk goes STRAIGHT into
 * registration — the structure, prices and cut-offs are the super admin's
 * game structure defaults, never typed at the desk — then Playing →
 * Finishing with the stepper always visible once a night is underway.
 */

export const HOST_STEPS = [
  { id: "host", label: "Registration" },
  { id: "play", label: "Playing" },
  { id: "finish", label: "Finishing" },
] as const

export default function HostWorkspace({ venue, mode = "tournament" }: { venue: Venue | null, mode?: "tournament" | "cash" }) {
  // A second station at the same desk can be pointed straight at the running
  // session rather than being walked back through the hub.
  const [sessionId, setSessionId] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("session"))
    return Number.isInteger(requested) && requested > 0 ? requested : null
  })
  const [stage, setStage] = useState<"desk" | "finish">("desk")
  const [clockStatus, setClockStatus] = useState<string>("draft")

  const opener = useOpenDesk(venue, (id) => {
    setSessionId(id)
    setStage("desk")
  })

  if (sessionId === null) {
    return (
      <>
        {opener.error ? <p className="host-desk__error" role="alert">{opener.error}</p> : null}
        <SessionsHub
          venue={venue}
          mode={mode}
          opening={opener.opening}
          onOpenLocal={(localTournamentId) => {
            setSessionId(localTournamentId)
            setStage("desk")
          }}
          onOpen={(gameSessionId) => void opener.open(mode, gameSessionId)}
        />
        {opener.dialog}
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
          mode={mode}
          onBack={() => setStage("desk")}
          onFinished={() => {
            setStage("desk")
            setSessionId(null)
          }}
        />
      ) : (
        <HostDesk
          sessionId={sessionId}
          mode={mode}
          onExit={() => setSessionId(null)}
          onClockStatus={setClockStatus}
          onFinishGame={() => setStage("finish")}
        />
      )}
    </div>
  )
}
