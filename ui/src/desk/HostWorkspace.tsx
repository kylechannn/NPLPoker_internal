import { useState } from "react"
import FinishGame from "./FinishGame"
import HostDesk from "./HostDesk"
import HostPreset from "./HostPreset"
import type { Venue } from "./deskApi"
import "./host.css"

/**
 * The Host tab: one night, four steps, and the stepper never disappears —
 * Preparation → Host → Playing → Finishing. Preparation renders its own
 * (richer) header; the desk and finishing screens share the compact bar
 * below so the staff always knows where the night stands.
 */

export const HOST_STEPS = [
  { id: "prepare", label: "Preparation" },
  { id: "host", label: "Host" },
  { id: "play", label: "Playing" },
  { id: "finish", label: "Finishing" },
] as const

export default function HostWorkspace({ venue }: { venue: Venue | null }) {
  // A second station at the same desk can be pointed straight at the running
  // session rather than being walked back through the preset screen.
  const [sessionId, setSessionId] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("session"))
    return Number.isInteger(requested) && requested > 0 ? requested : null
  })
  const [stage, setStage] = useState<"desk" | "finish">("desk")
  const [clockStatus, setClockStatus] = useState<string>("draft")

  if (sessionId === null) {
    return (
      <HostPreset
        venue={venue}
        onOpened={(id) => {
          setSessionId(id)
          setStage("desk")
        }}
      />
    )
  }

  const currentStep = stage === "finish" ? 3 : clockStatus === "running" || clockStatus === "paused" ? 2 : 1

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
                if (step.id === "prepare") setSessionId(null)
                else if (step.id === "finish") setStage("finish")
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
          onBack={() => setStage("desk")}
          onFinished={() => {
            setStage("desk")
            setSessionId(null)
          }}
        />
      ) : (
        <HostDesk
          sessionId={sessionId}
          onExit={() => setSessionId(null)}
          onClockStatus={setClockStatus}
          onFinishGame={() => setStage("finish")}
        />
      )}
    </div>
  )
}
