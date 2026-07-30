import { useState } from "react"
import CashPreset from "./CashPreset"
import FinishGame from "./FinishGame"
import HostDesk from "./HostDesk"
import HostPreset from "./HostPreset"
import SessionsHub from "./SessionsHub"
import type { Venue } from "./deskApi"
import "./host.css"

/**
 * The Tournament tab, staged: the Sessions hub is the front door (tonight's
 * cloud sessions with live counts), then Preparation → Host → Playing →
 * Finishing with the stepper always visible once a night is underway.
 */

export const HOST_STEPS = [
  { id: "prepare", label: "Preparation" },
  { id: "host", label: "Host" },
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
  const [view, setView] = useState<"hub" | "prep">("hub")
  const [prepLink, setPrepLink] = useState<number | null>(null)
  const [stage, setStage] = useState<"desk" | "finish">("desk")
  const [clockStatus, setClockStatus] = useState<string>("draft")
  // Back-to-prep for an open draft: everything stays editable until Start.
  const [editingSession, setEditingSession] = useState<number | null>(null)

  const Preset = mode === "cash" ? CashPreset : HostPreset

  if (editingSession !== null) {
    return (
      <Preset
        venue={venue}
        editSessionId={editingSession}
        onBack={() => setEditingSession(null)}
        onOpened={() => {
          setEditingSession(null)
          setStage("desk")
        }}
      />
    )
  }

  if (sessionId === null) {
    if (view === "prep") {
      return (
        <Preset
          venue={venue}
          initialLinkedSessionId={prepLink}
          onBack={() => setView("hub")}
          onOpened={(id) => {
            setSessionId(id)
            setStage("desk")
          }}
        />
      )
    }

    return (
      <SessionsHub
        venue={venue}
        mode={mode}
        onOpenLocal={(localTournamentId) => {
          setSessionId(localTournamentId)
          setStage("desk")
        }}
        onPrepare={(gameSessionId) => {
          setPrepLink(gameSessionId)
          setView("prep")
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
                if (step.id === "prepare") {
                  // A draft goes BACK to preparation with everything
                  // editable; once Start has been pressed the night is
                  // committed and Preparation exits to the sessions hub.
                  if (clockStatus === "draft") {
                    setEditingSession(sessionId)
                  } else {
                    setSessionId(null)
                    setView("hub")
                  }
                } else if (step.id === "finish") setStage("finish")
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
            setView("hub")
          }}
        />
      ) : (
        <HostDesk
          sessionId={sessionId}
          mode={mode}
          onExit={() => {
            setSessionId(null)
            setView("hub")
          }}
          onClockStatus={setClockStatus}
          onFinishGame={() => setStage("finish")}
        />
      )}
    </div>
  )
}
