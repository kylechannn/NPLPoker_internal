import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react'
import { hueGradients, wheelPrizes } from './wheelPrizes'
import type { WheelPrize } from './wheelPrizes'

/** A real draw performed by the NPL cloud — the wheel animates to it. */
export type SpinOutcome = {
  segmentIndex: number
  prizeLabel: string
  voucherCode: string | null
  voucherExpiresAt: string | null
  pointsAmount: number | null
  playerName: string
  /** The cloud reference of this spin — a golden follow-up quotes it. */
  reference: string | null
  /** Set when the spin landed on the golden segment: open the golden wheel. */
  followUp: 'golden_wheel' | null
}

type PrizeWheelProps = {
  /** Live catalog segments; falls back to the preview fixture. */
  prizes?: WheelPrize[]
  /** The all-golden follow-up wheel — golden chrome, same physics. */
  golden?: boolean
  /**
   * When provided the wheel is REAL: this asks the cloud (via the local
   * host) to draw, and the rotor lands on the returned segment. Without it
   * the wheel is a local, award-nothing simulation.
   */
  requestSpin?: () => Promise<SpinOutcome | null>
  onResult?: (prize: WheelPrize) => void
  /**
   * Fires only when the rotor has physically landed — not when the cloud
   * answers. The workspace reveals the reward off this, so the card can
   * never spoil the wheel mid-spin.
   */
  onSettled?: (outcome: SpinOutcome) => void
}

const ROTOR_SIZE = 500
const ROTOR_CENTER = ROTOR_SIZE / 2
const ROTOR_RADIUS = 246
const RIM_SIZE = 560
const RIM_CENTER = RIM_SIZE / 2
// Rotor-space radius kept clear of segment hover so the hub button owns the center.
const HUB_CLEAR_RADIUS = 84
const BULB_COUNT = 32
const BULB_RADIUS = 262
const SPIN_DURATION_MS = 6200
const REDUCED_SPIN_DURATION_MS = 400

const confettiColors = ['#00e5ff', '#3d7bff', '#ff2bd6', '#ffd23d', '#2bffb0', '#ff4d6a', '#9d4dff']
const boltColors = ['#00e5ff', '#7b9dff', '#ff2bd6', '#b7f4ff', '#9d4dff']

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function polarPoint(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: ROTOR_CENTER + radius * Math.cos(rad), y: ROTOR_CENTER + radius * Math.sin(rad) }
}

function slicePath(startAngle: number, endAngle: number): string {
  const from = polarPoint(startAngle, ROTOR_RADIUS)
  const to = polarPoint(endAngle, ROTOR_RADIUS)
  return `M ${ROTOR_CENTER} ${ROTOR_CENTER} L ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${ROTOR_RADIUS} ${ROTOR_RADIUS} 0 0 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)} Z`
}

function pickWeightedIndex(prizes: WheelPrize[]): number {
  const total = prizes.reduce((sum, prize) => sum + prize.weight, 0)
  let roll = Math.random() * total
  for (let i = 0; i < prizes.length; i += 1) {
    roll -= prizes[i].weight
    if (roll < 0) return i
  }
  return prizes.length - 1
}

type ConfettiPiece = {
  left: string
  delay: string
  duration: string
  color: string
  width: number
  height: number
}

function makeConfetti(count: number): ConfettiPiece[] {
  return Array.from({ length: count }, () => ({
    left: `${(Math.random() * 100).toFixed(1)}%`,
    delay: `${(Math.random() * 0.9).toFixed(2)}s`,
    duration: `${(2.4 + Math.random() * 1.6).toFixed(2)}s`,
    color: confettiColors[Math.floor(Math.random() * confettiColors.length)],
    width: 6 + Math.round(Math.random() * 6),
    height: 10 + Math.round(Math.random() * 8),
  }))
}

type Point = { x: number; y: number }

type Bolt = {
  points: Point[]
  branches: Point[][]
  born: number
  life: number
  color: string
  width: number
  seed: number
  impactAngle: number
}

/** Rim surge — energy absorbed from a bolt, rippling along the wheel edge. */
type Surge = {
  angle: number
  born: number
  life: number
  color: string
  span: number
}

const RIM_CANVAS_FRACTION = 0.366

/** Jagged strike from outside the frame onto the wheel, via midpoint displacement. */
function makeBolt(now: number, width: number, height: number, dpr: number): Bolt {
  const cx = width / 2
  const cy = height / 2
  const angle = Math.random() * Math.PI * 2
  const outerRadius = Math.hypot(width, height) / 2
  // Some strikes ground on the rim, others travel across the face to the hub button.
  const reachRadius = Math.min(width, height) * (Math.random() < 0.45 ? 0.105 : 0.2 + Math.random() * 0.17)
  const endAngle = angle + (Math.random() - 0.5) * 0.55
  let points: Point[] = [
    { x: cx + Math.cos(angle) * outerRadius, y: cy + Math.sin(angle) * outerRadius },
    { x: cx + Math.cos(endAngle) * reachRadius, y: cy + Math.sin(endAngle) * reachRadius },
  ]

  // Where the strike crosses the rim — the absorption point for the edge surge.
  const rimRadius = Math.min(width, height) * RIM_CANVAS_FRACTION
  const crossT = Math.min(1, Math.max(0, (outerRadius - rimRadius) / (outerRadius - reachRadius)))
  const crossX = points[0].x + (points[1].x - points[0].x) * crossT
  const crossY = points[0].y + (points[1].y - points[0].y) * crossT
  const impactAngle = Math.atan2(crossY - cy, crossX - cx)

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const next: Point[] = [points[0]]
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]
      const b = points[i]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const length = Math.hypot(dx, dy) || 1
      const offset = (Math.random() - 0.5) * length * 0.42
      next.push({ x: (a.x + b.x) / 2 - (dy / length) * offset, y: (a.y + b.y) / 2 + (dx / length) * offset }, b)
    }
    points = next
  }

  const branches: Point[][] = []
  for (let i = 6; i < points.length - 6; i += 7) {
    if (Math.random() > 0.58) continue
    const branch: Point[] = [points[i]]
    let px = points[i].x
    let py = points[i].y
    const branchAngle = Math.random() * Math.PI * 2
    for (let step = 0; step < 4; step += 1) {
      px += Math.cos(branchAngle) * 11 * dpr + (Math.random() - 0.5) * 16 * dpr
      py += Math.sin(branchAngle) * 11 * dpr + (Math.random() - 0.5) * 16 * dpr
      branch.push({ x: px, y: py })
    }
    branches.push(branch)
  }

  return {
    points,
    branches,
    born: now,
    life: 280 + Math.random() * 240,
    color: boltColors[Math.floor(Math.random() * boltColors.length)],
    width: (1 + Math.random() * 1.5) * dpr,
    seed: Math.random() * 10,
    impactAngle,
  }
}

function strokePolyline(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath()
  ctx.moveTo(points[0].x, points[0].y)
  for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y)
  ctx.stroke()
}

export default function PrizeWheel({ prizes = wheelPrizes, golden = false, requestSpin, onResult, onSettled }: PrizeWheelProps) {
  // Slice size follows the odds: the easier a prize is to win, the bigger
  // its wedge — the wheel face itself shows the chances honestly.
  const arcs = useMemo(() => {
    const total = prizes.reduce((sum, prize) => sum + Math.max(1, prize.weight), 0)
    let cursor = 0
    return prizes.map((prize) => {
      const span = (Math.max(1, prize.weight) / total) * 360
      const arc = { start: cursor, span, mid: cursor + span / 2 }
      cursor += span
      return arc
    })
  }, [prizes])
  const [rotation, setRotation] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [drawing, setDrawing] = useState(false)
  const [outcome, setOutcome] = useState<SpinOutcome | null>(null)
  const [winner, setWinner] = useState<WheelPrize | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)
  const settleTimerRef = useRef<number>(0)
  const onResultRef = useRef(onResult)
  const onSettledRef = useRef(onSettled)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const spinningRef = useRef(false)
  const hoveringRef = useRef(false)
  const burstRef = useRef(0)
  const tiltTargetRef = useRef({ x: 0, y: 0, glare: 0 })

  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  useEffect(() => {
    onSettledRef.current = onSettled
  }, [onSettled])

  useEffect(() => () => window.clearTimeout(settleTimerRef.current), [])

  useEffect(() => {
    spinningRef.current = spinning
  }, [spinning])

  useEffect(() => {
    if (!modalOpen) return
    burstRef.current += 9
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setModalOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [modalOpen])

  /* Storm canvas — procedural lightning strikes charging the rim. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || prefersReducedMotion()) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let bolts: Bolt[] = []
    let surges: Surge[] = []
    let nextStrike = performance.now() + 120
    let raf = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }
    resize()
    window.addEventListener('resize', resize)

    const tick = (now: number) => {
      if (burstRef.current > 0) {
        for (let i = 0; i < burstRef.current; i += 1) {
          const bolt = makeBolt(now, canvas.width, canvas.height, dpr)
          bolt.born = now + i * 55
          bolts.push(bolt)
        }
        burstRef.current = 0
      }
      if (now >= nextStrike) {
        const strikeCount = 3 + (Math.random() < 0.7 ? 1 : 0) + (Math.random() < 0.45 ? 1 : 0) + (Math.random() < 0.25 ? 1 : 0)
        for (let i = 0; i < strikeCount; i += 1) {
          const bolt = makeBolt(now, canvas.width, canvas.height, dpr)
          bolt.born = now + i * 45
          bolts.push(bolt)
        }
        const idleDelay = 120 + Math.random() * 260
        nextStrike = now + (spinningRef.current ? 35 + Math.random() * 80 : hoveringRef.current ? idleDelay * 0.45 : idleDelay)
      }
      if (bolts.length > 64) bolts.splice(0, bolts.length - 64)

      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // Expired bolts hand their charge to the rim as a travelling surge.
      const alive: Bolt[] = []
      for (const bolt of bolts) {
        if (now - bolt.born < bolt.life) {
          alive.push(bolt)
        } else {
          surges.push({
            angle: bolt.impactAngle,
            born: now,
            life: 550 + Math.random() * 350,
            color: bolt.color,
            span: 0.5 + Math.random() * 0.55,
          })
        }
      }
      bolts = alive
      if (surges.length > 18) surges.splice(0, surges.length - 18)

      for (const bolt of bolts) {
        const t = (now - bolt.born) / bolt.life
        if (t < 0) continue
        const envelope = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88
        const alpha = Math.max(0, envelope) * (0.55 + 0.45 * Math.sin(now * 0.09 + bolt.seed))

        ctx.shadowColor = bolt.color
        ctx.shadowBlur = 16 * dpr

        ctx.globalAlpha = alpha * 0.55
        ctx.strokeStyle = bolt.color
        ctx.lineWidth = bolt.width * 2.6
        strokePolyline(ctx, bolt.points)
        for (const branch of bolt.branches) strokePolyline(ctx, branch)

        ctx.globalAlpha = alpha
        ctx.strokeStyle = '#eafcff'
        ctx.lineWidth = bolt.width
        strokePolyline(ctx, bolt.points)

        // Impact glow where the strike meets the rim.
        const impact = bolt.points[bolt.points.length - 1]
        const glow = ctx.createRadialGradient(impact.x, impact.y, 0, impact.x, impact.y, 46 * dpr)
        glow.addColorStop(0, bolt.color)
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)')
        ctx.globalAlpha = alpha * 0.35
        ctx.shadowBlur = 0
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(impact.x, impact.y, 46 * dpr, 0, Math.PI * 2)
        ctx.fill()
      }

      // Empowered rim — absorbed charge ripples along the edge and fades.
      surges = surges.filter((surge) => now - surge.born < surge.life)
      const rimR = Math.min(canvas.width, canvas.height) * RIM_CANVAS_FRACTION
      const hubX = canvas.width / 2
      const hubY = canvas.height / 2
      for (const surge of surges) {
        const t = (now - surge.born) / surge.life
        const spread = 0.1 + (1 - Math.pow(1 - t, 3)) * surge.span
        const fade = 1 - t

        ctx.shadowColor = surge.color
        ctx.shadowBlur = 18 * dpr
        ctx.globalAlpha = fade * 0.65
        ctx.strokeStyle = surge.color
        ctx.lineWidth = 3.6 * dpr * (1 - 0.45 * t)
        ctx.beginPath()
        ctx.arc(hubX, hubY, rimR, surge.angle - spread, surge.angle + spread)
        ctx.stroke()

        ctx.globalAlpha = fade * 0.9
        ctx.strokeStyle = '#eafcff'
        ctx.lineWidth = 1.4 * dpr
        ctx.beginPath()
        ctx.arc(hubX, hubY, rimR, surge.angle - spread * 0.8, surge.angle + spread * 0.8)
        ctx.stroke()

        // Bright absorption flash right where the bolt fed the rim.
        if (t < 0.3) {
          const fx = hubX + Math.cos(surge.angle) * rimR
          const fy = hubY + Math.sin(surge.angle) * rimR
          const flash = ctx.createRadialGradient(fx, fy, 0, fx, fy, 34 * dpr)
          flash.addColorStop(0, surge.color)
          flash.addColorStop(1, 'rgba(0, 0, 0, 0)')
          ctx.globalAlpha = (1 - t / 0.3) * 0.8
          ctx.shadowBlur = 0
          ctx.fillStyle = flash
          ctx.beginPath()
          ctx.arc(fx, fy, 34 * dpr, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      ctx.globalAlpha = 1
      ctx.shadowBlur = 0
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  /* Mouse-driven 3D tilt + glare, smoothed with a lerp so it feels weighty. */
  useEffect(() => {
    if (prefersReducedMotion()) return
    const current = { x: 0, y: 0, glare: 0 }
    let raf = 0

    const loop = () => {
      const target = tiltTargetRef.current
      current.x += (target.x - current.x) * 0.1
      current.y += (target.y - current.y) * 0.1
      current.glare += (target.glare - current.glare) * 0.08
      // Snap when close — an asymptotic tail keeps the transform non-identity for
      // seconds, which makes hit-testing over the hub button flicker.
      if (Math.abs(target.x - current.x) < 0.003) current.x = target.x
      if (Math.abs(target.y - current.y) < 0.003) current.y = target.y
      if (Math.abs(target.glare - current.glare) < 0.01) current.glare = target.glare
      const scene = sceneRef.current
      if (scene) {
        scene.style.setProperty('--tilt-x', `${(-current.y * 5).toFixed(3)}deg`)
        scene.style.setProperty('--tilt-y', `${(current.x * 6.5).toFixed(3)}deg`)
        scene.style.setProperty('--glare-o', current.glare.toFixed(3))
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])

  const confetti = useMemo(() => (modalOpen ? makeConfetti(38) : []), [modalOpen])

  function handleStageMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    const px = (event.clientX - rect.left) / rect.width
    const py = (event.clientY - rect.top) / rect.height
    const dx = px * 2 - 1
    const dy = py * 2 - 1
    // Ease the tilt to zero near the hub so the spin button stays still under the cursor.
    const dist = Math.hypot(dx, dy)
    const ramp = Math.min(1, Math.max(0, (dist - 0.32) / 0.36))
    const damp = ramp * ramp * (3 - 2 * ramp)
    tiltTargetRef.current = { x: dx * damp, y: dy * damp, glare: 1 }
    hoveringRef.current = true
    const scene = sceneRef.current
    if (scene) {
      scene.style.setProperty('--mx', `${(px * 100).toFixed(2)}%`)
      scene.style.setProperty('--my', `${(py * 100).toFixed(2)}%`)
    }
  }

  function handleStageMouseLeave() {
    tiltTargetRef.current = { x: 0, y: 0, glare: 0 }
    hoveringRef.current = false
    setHovered(null)
  }

  async function spin() {
    if (spinning || drawing) return

    setModalOpen(false)
    setWinner(null)
    setOutcome(null)
    setHovered(null)

    // Real wheels ask the cloud for the winner; the rotor then lands on the
    // server's segment. Preview wheels draw locally and award nothing.
    let index: number
    let landedOutcome: SpinOutcome | null = null

    if (requestSpin) {
      setDrawing(true)
      try {
        landedOutcome = await requestSpin()
      } catch {
        landedOutcome = null
      }
      setDrawing(false)
      if (!landedOutcome) return
      index = Math.min(Math.max(0, landedOutcome.segmentIndex), prizes.length - 1)
    } else {
      index = pickWeightedIndex(prizes)
    }

    const landed = prizes[index]
    const arc = arcs[index]
    const midAngle = arc.mid
    // Jitter stays inside the wedge, however narrow it is.
    const jitter = (Math.random() - 0.5) * Math.max(2, arc.span - 16)
    const targetMod = (((360 - midAngle + jitter) % 360) + 360) % 360
    const delta = ((targetMod - (rotation % 360)) % 360 + 360) % 360
    const reduced = prefersReducedMotion()
    const fullTurns = reduced ? 1 : 6 + Math.floor(Math.random() * 3)
    const duration = reduced ? REDUCED_SPIN_DURATION_MS : SPIN_DURATION_MS

    setSpinning(true)
    setRotation(rotation + fullTurns * 360 + delta)

    settleTimerRef.current = window.setTimeout(() => {
      setSpinning(false)
      setWinner(landed)
      setOutcome(landedOutcome)
      setModalOpen(true)
      onResultRef.current?.(landed)
      if (landedOutcome) onSettledRef.current?.(landedOutcome)
    }, duration + 150)
  }

  function handleSpinAgain() {
    setModalOpen(false)
    void spin()
  }

  const rotorStyle: CSSProperties = {
    transform: `rotate(${rotation}deg)`,
    transition: spinning
      ? `transform ${prefersReducedMotion() ? REDUCED_SPIN_DURATION_MS : SPIN_DURATION_MS}ms cubic-bezier(0.12, 0.82, 0.09, 0.99)`
      : 'none',
  }

  const hoveredPrize = hovered !== null ? prizes[hovered] : null
  const busy = spinning || drawing
  const real = Boolean(requestSpin)

  return (
    <div
      className={`npl-wheel-stage${spinning ? ' npl-wheel-stage--spinning' : ''}${golden ? ' npl-wheel-stage--golden' : ''}`}
      onMouseMove={handleStageMouseMove}
      onMouseLeave={handleStageMouseLeave}
    >
      <canvas ref={canvasRef} className="npl-wheel-storm" aria-hidden="true" />

      <div ref={sceneRef} className="npl-wheel-3d">
        <svg className="npl-wheel-rim" viewBox={`0 0 ${RIM_SIZE} ${RIM_SIZE}`} aria-hidden="true">
          <defs>
            <linearGradient id="npl-wheel-rim-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00e5ff" />
              <stop offset="35%" stopColor="#1b3f7d" />
              <stop offset="65%" stopColor="#ff2bd6" />
              <stop offset="100%" stopColor="#123a6b" />
            </linearGradient>
          </defs>
          <circle className="npl-wheel-arc npl-wheel-arc--a" cx={RIM_CENTER} cy={RIM_CENTER} r="276" />
          <circle className="npl-wheel-arc npl-wheel-arc--b" cx={RIM_CENTER} cy={RIM_CENTER} r="271" />
          <circle cx={RIM_CENTER} cy={RIM_CENTER} r={BULB_RADIUS} fill="none" stroke="url(#npl-wheel-rim-grad)" strokeWidth="13" opacity="0.9" />
          <circle cx={RIM_CENTER} cy={RIM_CENTER} r={BULB_RADIUS} fill="none" stroke="rgba(1, 5, 15, 0.75)" strokeWidth="13" strokeDasharray="1.5 12" />
          <circle cx={RIM_CENTER} cy={RIM_CENTER} r={BULB_RADIUS - 8.5} fill="none" stroke="rgba(1, 5, 15, 0.9)" strokeWidth="2" />
          {Array.from({ length: BULB_COUNT }, (_, i) => {
            const rad = (i / BULB_COUNT) * Math.PI * 2
            const x = RIM_CENTER + BULB_RADIUS * Math.sin(rad)
            const y = RIM_CENTER - BULB_RADIUS * Math.cos(rad)
            return (
              <circle
                key={i}
                className={`npl-wheel-bulb npl-wheel-bulb--${i % 2 === 0 ? 'cyan' : 'magenta'}`}
                cx={x.toFixed(2)}
                cy={y.toFixed(2)}
                r="4.2"
                style={{ animationDelay: spinning ? `${(i * 0.04).toFixed(3)}s` : `${(i % 4) * 0.45}s` }}
              />
            )
          })}
        </svg>

        <div className="npl-wheel-rotor" style={rotorStyle}>
          <svg viewBox={`0 0 ${ROTOR_SIZE} ${ROTOR_SIZE}`} role="img" aria-label="Prize wheel simulation">
            <defs>
              {Object.entries(hueGradients).map(([hue, [edge, core]]) => (
                <radialGradient key={hue} id={`npl-wheel-grad-${hue}`} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={core} />
                  <stop offset="42%" stopColor={core} />
                  <stop offset="100%" stopColor={edge} />
                </radialGradient>
              ))}
              <radialGradient id="npl-wheel-shade" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="rgba(0, 229, 255, 0.05)" />
                <stop offset="55%" stopColor="rgba(255, 255, 255, 0)" />
                <stop offset="100%" stopColor="rgba(0, 0, 0, 0.45)" />
              </radialGradient>
            </defs>

            {prizes.map((segment, index) => {
              const { start, span, mid } = arcs[index]
              // Narrow wedges shrink their words so the text stays inside.
              const textScale = Math.max(0.4, Math.min(1.05, span / 34))
              const labelSize = Math.round(21 * textScale)
              const oddsSize = Math.round(14 * textScale)
              return (
                <g
                  key={segment.id}
                  className={`npl-wheel-seg${hovered === index ? ' npl-wheel-seg--hot' : ''}`}
                  onPointerEnter={() => !spinning && setHovered(index)}
                  onPointerLeave={() => setHovered((value) => (value === index ? null : value))}
                >
                  <path
                    d={slicePath(start, start + span)}
                    fill={`url(#npl-wheel-grad-${segment.hue})`}
                    stroke="#02040f"
                    strokeWidth="2.5"
                  />
                  <g transform={`rotate(${mid} ${ROTOR_CENTER} ${ROTOR_CENTER})`} pointerEvents="none">
                    <text className="npl-wheel-label" fontSize={labelSize} x={ROTOR_CENTER} y="74" textAnchor="middle">
                      <tspan x={ROTOR_CENTER} y="74">{segment.lines[0]}</tspan>
                      <tspan x={ROTOR_CENTER} y={74 + Math.round(25 * textScale)}>{segment.lines[1]}</tspan>
                    </text>
                    <text className="npl-wheel-odds" fontSize={oddsSize} x={ROTOR_CENTER} y={74 + Math.round(52 * textScale)} textAnchor="middle">
                      {segment.weight}%
                    </text>
                  </g>
                </g>
              )
            })}

            {prizes.map((segment, index) => {
              const edge = polarPoint(arcs[index].start, ROTOR_RADIUS)
              return (
                <line
                  key={`divider-${segment.id}`}
                  x1={ROTOR_CENTER}
                  y1={ROTOR_CENTER}
                  x2={edge.x.toFixed(2)}
                  y2={edge.y.toFixed(2)}
                  stroke="rgba(150, 240, 255, 0.3)"
                  strokeWidth="1.2"
                  pointerEvents="none"
                />
              )
            })}

            <circle cx={ROTOR_CENTER} cy={ROTOR_CENTER} r={ROTOR_RADIUS} fill="none" stroke="rgba(0, 229, 255, 0.4)" strokeWidth="1.6" pointerEvents="none" />
            <circle cx={ROTOR_CENTER} cy={ROTOR_CENTER} r={ROTOR_RADIUS} fill="url(#npl-wheel-shade)" pointerEvents="none" />

            {/* Dead zone over the hub — blocks segment hover from crossing into the spin button. */}
            <circle cx={ROTOR_CENTER} cy={ROTOR_CENTER} r={HUB_CLEAR_RADIUS} fill="transparent" style={{ cursor: 'default' }} />
          </svg>
        </div>

        <div className="npl-wheel-glare" aria-hidden="true" />

        <span className="npl-wheel-pointer" aria-hidden="true" />

        <button type="button" className="npl-wheel-hub" onClick={() => void spin()} disabled={busy}>
          <strong>{busy ? '···' : real ? 'SPIN' : 'SIM'}</strong>
          <small>{drawing ? 'DRAWING' : spinning ? 'SPINNING' : real ? 'SPIN TO WIN' : 'RUN PREVIEW'}</small>
        </button>
      </div>

      <p className="npl-wheel-status" role="status">
        {drawing
          ? 'Drawing with the NPL cloud…'
          : spinning
            ? real ? 'Spinning…' : 'Running local simulation…'
            : hoveredPrize
              ? `${hoveredPrize.prize} — ${hoveredPrize.weight}%`
              : winner
                ? `${real ? 'Last prize' : 'Last simulation'}: ${winner.prize}`
                : real
                  ? 'Press the wheel to spin for this player.'
                  : 'Press the wheel to run a local preview.'}
      </p>

      {modalOpen && winner ? createPortal(
        <div className="npl-wheel-modal" role="dialog" aria-modal="true" aria-labelledby="npl-wheel-winner">
          <div className="npl-wheel-modal__backdrop" onClick={() => setModalOpen(false)} />
          <div className="npl-wheel-modal__confetti" aria-hidden="true">
            {confetti.map((piece, i) => (
              <i
                key={i}
                style={{
                  left: piece.left,
                  width: piece.width,
                  height: piece.height,
                  background: piece.color,
                  animationDelay: piece.delay,
                  animationDuration: piece.duration,
                }}
              />
            ))}
          </div>
          <div className="npl-wheel-modal__card">
            <p className="npl-kicker">{outcome ? 'Jackpot Wheel' : 'Simulation Result'}</p>
            <span className="npl-wheel-modal__badge">{outcome ? '♠ Winner ♠' : '♠ Preview ♠'}</span>
            <h3 id="npl-wheel-winner">{outcome?.prizeLabel ?? winner.prize}</h3>
            {outcome ? (
              <p className="npl-wheel-modal__note">
                {outcome.playerName} won this prize.{' '}
                {outcome.voucherCode
                  ? `Voucher ${outcome.voucherCode}${outcome.voucherExpiresAt ? ` (valid to ${outcome.voucherExpiresAt})` : ''} has been sent to their inbox.`
                  : outcome.pointsAmount
                    ? `${outcome.pointsAmount.toLocaleString()} Loyalty Points are already in their wallet — a receipt is in their inbox.`
                    : 'The prize has been recorded and sent to their inbox.'}
              </p>
            ) : (
              <p className="npl-wheel-modal__note">
                This local simulation is not redeemable and creates no backend draw, entitlement, transaction, or audit record.
              </p>
            )}
            <div className="npl-wheel-modal__actions">
              {!outcome ? (
                <button type="button" className="npl-button npl-button--gold" onClick={handleSpinAgain}>
                  Simulate Again
                </button>
              ) : null}
              <button type="button" className={outcome ? 'npl-button npl-button--gold' : 'npl-button npl-button--outline'} onClick={() => setModalOpen(false)}>
                {outcome ? 'Done' : 'Close'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}
