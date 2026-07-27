import { useEffect, useState } from "react"
import nplLogoUrl from "./assets/npl-logo.png"

const ranks = ["A", "J", "Q", "K", "10", "9", "8", "7", "6", "5", "4", "3", "2"] as const
const spinPeriodMS = 1800

function prefersReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

function CardSide({ rank, side }: { rank: string; side: "face" | "back" }) {
  return (
    <div className={`npl-transit__card-side npl-transit__card-side--${side}`}>
      {side === "face" ? (
        <>
          <span className="npl-transit__pips npl-transit__pips--top" aria-hidden="true">
            <span className="npl-transit__rank">{rank}</span>
            <span className="npl-transit__suit">♠</span>
          </span>
          <img className="npl-transit__badge" src={nplLogoUrl} alt="" draggable={false} />
          <span className="npl-transit__pips npl-transit__pips--bottom" aria-hidden="true">
            <span className="npl-transit__rank">{rank}</span>
            <span className="npl-transit__suit">♠</span>
          </span>
        </>
      ) : (
        <>
          <span className="npl-transit__back-frame" aria-hidden="true" />
          <img
            className="npl-transit__badge npl-transit__badge--back"
            src={nplLogoUrl}
            alt=""
            draggable={false}
          />
        </>
      )}
    </div>
  )
}

export default function NplTransitLoader() {
  const [rankIndex, setRankIndex] = useState(0)

  useEffect(() => {
    if (prefersReducedMotion()) return

    let index = 0
    let intervalID = 0
    const timeoutID = window.setTimeout(() => {
      index = 1
      setRankIndex(index)
      intervalID = window.setInterval(() => {
        index = (index + 1) % ranks.length
        setRankIndex(index)
      }, spinPeriodMS)
    }, spinPeriodMS / 2)

    return () => {
      window.clearTimeout(timeoutID)
      window.clearInterval(intervalID)
    }
  }, [])

  const rank = ranks[rankIndex]

  return (
    <div className="npl-transit" role="status" aria-label="Loading NPL Operational System">
      <div className="npl-transit__stage">
        <div className="npl-transit__perspective" aria-hidden="true">
          <div className="npl-transit__spin">
            <div className="npl-transit__tilt">
              <CardSide rank={rank} side="face" />
              <CardSide rank={rank} side="back" />
            </div>
          </div>
        </div>

        <div className="npl-transit__words">
          <span className="npl-transit__label">LOADING</span>
          <span className="npl-transit__rail" aria-hidden="true">
            <span className="npl-transit__charge" />
          </span>
        </div>
      </div>
    </div>
  )
}
