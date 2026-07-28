import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import LicenseGate from "./LicenseGate"
import TimerDisplay from "./desk/TimerDisplay"
import "./styles.css"

/**
 * `?display=timer&session=N` renders the room clock on its own, with no
 * console chrome around it — that is what gets opened in a second window and
 * dragged onto the projector.
 *
 * It still sits behind the licence gate: an unlicensed install must not be
 * able to put a working display on a wall.
 */
const params = new URLSearchParams(window.location.search)
const sessionId = Number(params.get("session"))

const root = params.get("display") === "timer" && Number.isInteger(sessionId) && sessionId > 0
  ? <TimerDisplay sessionId={sessionId} />
  : <App />

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LicenseGate>
      {root}
    </LicenseGate>
  </StrictMode>,
)
