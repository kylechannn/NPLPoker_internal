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
import PrizeWheel from "./PrizeWheel"
import "./jackpot-wheel.css"

/** The Jackpot Wheel tab: just the wheel, exactly as it exists on the public site. */
export default function JackpotWheelWorkspace() {
  return (
    <div className="jackpot-wheel-view">
      <PrizeWheel />
    </div>
  )
}
