import { useState } from "react"
import HostDesk from "./HostDesk"
import HostPreset from "./HostPreset"
import type { Venue } from "./deskApi"
import "./host.css"

/**
 * The Host tab: set the game up, then run the desk.
 *
 * Two screens rather than one, because they are two jobs done at different
 * times by (often) different people — and because the preset decisions have
 * to be settled before a single player is charged anything.
 */
export default function HostWorkspace({ venue }: { venue: Venue | null }) {
  // A second station at the same desk can be pointed straight at the running
  // session rather than being walked back through the preset screen.
  const [sessionId, setSessionId] = useState<number | null>(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("session"))
    return Number.isInteger(requested) && requested > 0 ? requested : null
  })

  if (sessionId === null) {
    return <HostPreset venue={venue} onOpened={setSessionId} />
  }

  return <HostDesk sessionId={sessionId} onExit={() => setSessionId(null)} />
}
