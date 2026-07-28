import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { QRCodeSVG } from "qrcode.react"
import NplTransitLoader from "./NplTransitLoader"
import HostWorkspace from "./desk/HostWorkspace"
import JackpotWheelWorkspace from "./jackpot/JackpotWheelWorkspace"
import { deskApi, type Venue } from "./desk/deskApi"
import { describeRun, syncApi } from "./sync/syncApi"
import nplLogoUrl from "./assets/npl-logo.png"
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  Gauge,
  IdCard,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LoaderPinwheel,
  LogOut,
  Medal,
  Menu,
  Minus,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Spade,
  Square,
  Table2,
  Trophy,
  Undo2,
  UserPlus,
  Users,
  X,
  type LucideIcon,
} from "lucide-react"
import type { LicenseStatus } from "./LicenseGate"

declare global {
  interface Window {
    __NPL_DESKTOP__?: boolean
    nplWindowMinimize?: () => Promise<void>
    nplWindowToggleMaximize?: () => Promise<boolean>
    nplWindowIsMaximized?: () => Promise<boolean>
    nplWindowStartDrag?: () => Promise<void>
    nplWindowClose?: () => Promise<void>
  }
}

type Health = {
  ok: boolean
  service: string
  version: string
  go_version: string
  resource_profile: string
  go_max_procs: number
  go_memory_limit_mib: number
  network_cache_seconds: number
  staff_login_enabled: boolean
  staff_gateway_url?: string
  time: string
}

type HealthState =
  | { status: "loading" }
  | { status: "ready"; health: Health }
  | { status: "error" }

type NetworkQuality = {
  online: boolean
  level: number
  bars: number
  grade: string
  summary: string
  latency_ms: number
  jitter_ms: number
  probe_success: number
  probe_total: number
  reliability_percent: number
  checked_at: string
  cache_seconds: number
}

type NetworkQualityState =
  | { status: "loading" }
  | { status: "ready"; quality: NetworkQuality }
  | { status: "error" }

type StaffIdentity = {
  id: string
  name: string
  role: string
  initials: string
}

type StaffLoginChallenge = {
  id: string
  login_url: string
  pairing_code: string
  status: "waiting" | "scanned" | "approved" | "expired" | "cancelled" | "locked"
  expires_at: string
  seconds_remaining: number
  staff?: StaffIdentity
}

type NavId =
  | "overview"
  | "tournament"
  | "cashgame"
  | "registrations"
  | "players"
  | "membership"
  | "jackpot"

type Player = {
  seat: number
  name: string
  nplId: string
  invested: number
  rebuys: number
  stack: number
  dealer?: boolean
}

type GameTable = {
  id: string
  number: string
  name: string
  game: string
  status: "Live" | "Seating" | "Paused"
  blinds: string
  hand: number
  elapsed: string
  players: Player[]
}

const navigation: Array<{
  label: string
  items: Array<{ id: NavId; label: string; icon: LucideIcon; badge?: number }>
}> = [
  {
    label: "Operations",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "tournament", label: "Tournament", icon: Trophy },
      { id: "cashgame", label: "Cash Game", icon: CircleDollarSign, badge: 5 },
      { id: "registrations", label: "Registrations", icon: ListChecks, badge: 6 },
      { id: "players", label: "Players", icon: Users },
      { id: "jackpot", label: "Jackpot Wheel", icon: LoaderPinwheel },
    ],
  },
  {
    label: "Club",
    items: [{ id: "membership", label: "Club Membership ID", icon: IdCard }],
  },
]

// Old pinned shortcuts (?tab=host / ?tab=tables) keep opening the same desks
// under their new names.
const legacyTabIds: Record<string, NavId> = {
  host: "tournament",
  tables: "cashgame",
}

const tables: GameTable[] = [
  {
    id: "table-03",
    number: "03",
    name: "Feature Table",
    game: "No Limit Hold'em",
    status: "Live",
    blinds: "$10 / $20",
    hand: 185,
    elapsed: "02:14:38",
    players: [
      { seat: 1, name: "Aiden Park", nplId: "NPL-08214", invested: 1000, rebuys: 1, stack: 1240 },
      { seat: 2, name: "Chloe Martin", nplId: "NPL-01762", invested: 500, rebuys: 0, stack: 820 },
      { seat: 3, name: "Ethan Wong", nplId: "NPL-10938", invested: 1000, rebuys: 1, stack: 660 },
      { seat: 4, name: "Mia Lopez", nplId: "NPL-04631", invested: 500, rebuys: 0, stack: 490, dealer: true },
      { seat: 5, name: "Noah Singh", nplId: "NPL-07115", invested: 500, rebuys: 0, stack: 1150 },
      { seat: 6, name: "Zara King", nplId: "NPL-02489", invested: 1000, rebuys: 1, stack: 640 },
    ],
  },
  {
    id: "table-01",
    number: "01",
    name: "Main Floor",
    game: "No Limit Hold'em",
    status: "Live",
    blinds: "$5 / $10",
    hand: 142,
    elapsed: "01:48:12",
    players: [
      { seat: 1, name: "Liam Scott", nplId: "NPL-03128", invested: 500, rebuys: 0, stack: 680 },
      { seat: 2, name: "Sofia Tran", nplId: "NPL-06110", invested: 500, rebuys: 0, stack: 410 },
      { seat: 4, name: "Leo Zhang", nplId: "NPL-09871", invested: 1000, rebuys: 1, stack: 1180, dealer: true },
      { seat: 5, name: "Grace Hall", nplId: "NPL-01452", invested: 500, rebuys: 0, stack: 730 },
    ],
  },
  {
    id: "table-02",
    number: "02",
    name: "North Room",
    game: "Pot Limit Omaha",
    status: "Live",
    blinds: "$5 / $10",
    hand: 96,
    elapsed: "01:21:47",
    players: [
      { seat: 1, name: "Jack Turner", nplId: "NPL-05519", invested: 1000, rebuys: 1, stack: 1340 },
      { seat: 3, name: "Ava Patel", nplId: "NPL-03741", invested: 500, rebuys: 0, stack: 620, dealer: true },
      { seat: 5, name: "Kai Wilson", nplId: "NPL-08773", invested: 500, rebuys: 0, stack: 350 },
    ],
  },
  {
    id: "table-04",
    number: "04",
    name: "East Wing",
    game: "No Limit Hold'em",
    status: "Paused",
    blinds: "$5 / $10",
    hand: 73,
    elapsed: "00:58:03",
    players: [
      { seat: 2, name: "Emma Reed", nplId: "NPL-06339", invested: 500, rebuys: 0, stack: 570 },
      { seat: 4, name: "Henry Liu", nplId: "NPL-02218", invested: 500, rebuys: 0, stack: 430, dealer: true },
    ],
  },
  {
    id: "table-05",
    number: "05",
    name: "Championship",
    game: "Freezeout",
    status: "Seating",
    blinds: "Level 1",
    hand: 0,
    elapsed: "Starts 7:30 PM",
    players: [],
  },
]

const moduleTitles: Record<NavId, { eyebrow: string; title: string; description: string }> = {
  overview: {
    eyebrow: "Venue command",
    title: "Operations overview",
    description: "One view of tonight's floor, this install's licence, and operational health.",
  },
  tournament: {
    eyebrow: "Venue command",
    title: "Tournament",
    description: "Set the structure, prices and cut-offs, then run the desk.",
  },
  cashgame: {
    eyebrow: "Cash game floor",
    title: "Cash game",
    description: "Run cash tables — stacks, buy-ins, rebuys, and the live waitlist.",
  },
  registrations: {
    eyebrow: "Player operations",
    title: "Registrations",
    description: "Review arrivals, seat players, and manage the live waitlist.",
  },
  players: {
    eyebrow: "Player operations",
    title: "Players",
    description: "Find local players and review their venue activity.",
  },
  membership: {
    eyebrow: "Club programme",
    title: "Club Membership ID",
    description: "Issue and verify club member IDs tied to NPL player accounts.",
  },
  jackpot: {
    eyebrow: "Club programme",
    title: "Jackpot Wheel",
    description: "Spin the venue jackpot wheel and track the live prize pool.",
  },
}

type PreviewNavId = Exclude<NavId, "overview" | "tournament" | "cashgame" | "jackpot">

const modulePreviewCards: Record<PreviewNavId, Array<[string, string, string]>> = {
  registrations: [
    ["Checked in", "54", "For today's sessions"],
    ["Waiting", "6", "Longest wait 11 min"],
    ["Seats open", "9", "Across three tables"],
  ],
  players: [
    ["Venue players", "1,284", "Local synced roster"],
    ["Active tonight", "47", "Across all sessions"],
    ["Needs review", "2", "Identity checks"],
  ],
  membership: [
    ["Members enrolled", "1,284", "Linked NPL accounts"],
    ["Cards issued", "312", "Physical club IDs"],
    ["Pending prints", "9", "Queued for next batch"],
  ],
}

const modulePreviewIcons: Record<PreviewNavId, LucideIcon> = {
  registrations: ListChecks,
  players: Users,
  membership: IdCard,
}

function money(value: number) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatSignalCheck(value: string) {
  return new Intl.DateTimeFormat("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(new Date(value))
}

function ConnectionSignal({
  state,
  expanded,
  refreshing,
  onToggle,
  onRefresh,
}: {
  state: NetworkQualityState
  expanded: boolean
  refreshing: boolean
  onToggle: () => void
  onRefresh: () => void
}) {
  const quality = state.status === "ready" ? state.quality : null
  const level = quality?.level ?? 0
  const bars = quality?.bars ?? 0
  const online = quality?.online ?? false
  const grade = state.status === "loading"
    ? "Checking"
    : state.status === "error"
      ? "Unavailable"
      : quality?.grade ?? "Offline"
  const tone = !online
    ? "offline"
    : level <= 2
      ? "critical"
      : level <= 4
        ? "weak"
        : level <= 6
          ? "fair"
          : level <= 8
            ? "good"
            : "excellent"

  return (
    <section className={`connection-signal connection-signal--${tone}`}>
      <button
        className="connection-signal__summary"
        type="button"
        aria-expanded={expanded}
        aria-controls="connection-quality-details"
        aria-label={`${grade} internet connection, ${bars} of 5 signal bars${online ? `, level ${level} of 10` : ""}`}
        onClick={onToggle}
      >
        <span className="signal-bars" aria-hidden="true">
          {Array.from({ length: 5 }, (_, index) => (
            <i className={index < bars ? "signal-bar signal-bar--active" : "signal-bar"} key={index} />
          ))}
        </span>
        <span className="connection-signal__copy">
          <small>Internet signal</small>
          <strong>{grade}</strong>
        </span>
        <ChevronDown className={expanded ? "connection-signal__chevron connection-signal__chevron--open" : "connection-signal__chevron"} size={19} />
      </button>

      {expanded ? (
        <div className="connection-details" id="connection-quality-details">
          <header>
            <div>
              <small>Connection quality</small>
              <strong>{online ? `Level ${level} / 10` : grade}</strong>
            </div>
            <button
              className={refreshing ? "connection-refresh connection-refresh--active" : "connection-refresh"}
              type="button"
              aria-label="Check internet signal now"
              disabled={refreshing}
              onClick={onRefresh}
            >
              <RefreshCw size={18} />
            </button>
          </header>

          {quality && online ? (
            <>
              <p className="connection-details__summary">{quality.summary}</p>
              <dl className="connection-metrics">
                <div>
                  <dt>Latency</dt>
                  <dd>{quality.latency_ms} <small>ms</small></dd>
                </div>
                <div>
                  <dt>Reliability</dt>
                  <dd>{quality.reliability_percent}<small>%</small></dd>
                </div>
                <div>
                  <dt>Jitter</dt>
                  <dd>{quality.jitter_ms} <small>ms</small></dd>
                </div>
              </dl>
              <p className="connection-details__method">
                {quality.probe_success}/{quality.probe_total} routes responded · checked {formatSignalCheck(quality.checked_at)}
              </p>
            </>
          ) : (
            <p className="connection-details__summary">
              {state.status === "loading"
                ? "Measuring internet routes…"
                : "No internet route was detected. Local operations remain available."}
            </p>
          )}

          <footer>
            <ShieldCheck size={16} />
            <span>Lightweight check · local operations stay independent</span>
          </footer>
        </div>
      ) : null}
    </section>
  )
}

function StartupScreen({ leaving }: { leaving: boolean }) {
  return (
    <section
      className={leaving ? "startup-screen startup-screen--leaving" : "startup-screen"}
      role="status"
      aria-live="polite"
      aria-label="Starting NPL Operational System"
    >
      <div className="startup-screen__glow" aria-hidden="true" />
      <div className="startup-screen__content">
        <NplTransitLoader />
      </div>
    </section>
  )
}

function DesktopWindowControls({ hasPendingChanges }: { hasPendingChanges: boolean }) {
  const [maximized, setMaximized] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  useEffect(() => {
    const syncMaximizedState = () => {
      void window.nplWindowIsMaximized?.().then(setMaximized)
    }

    syncMaximizedState()
    window.addEventListener("resize", syncMaximizedState)
    return () => window.removeEventListener("resize", syncMaximizedState)
  }, [])

  useEffect(() => {
    if (!confirmClose) return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmClose(false)
    }
    window.addEventListener("keydown", handleEscape)
    return () => window.removeEventListener("keydown", handleEscape)
  }, [confirmClose])

  const toggleMaximized = () => {
    void window.nplWindowToggleMaximize?.().then(setMaximized)
  }

  const requestClose = () => {
    if (hasPendingChanges) {
      setConfirmClose(true)
      return
    }
    void window.nplWindowClose?.()
  }

  return (
    <>
      <div className="desktop-window-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" aria-label="Minimize window" title="Minimize" onClick={() => void window.nplWindowMinimize?.()}>
          <Minus size={15} strokeWidth={1.7} />
        </button>
        <button
          type="button"
          aria-label={maximized ? "Restore window" : "Maximize window"}
          title={maximized ? "Restore" : "Maximize"}
          onClick={toggleMaximized}
        >
          {maximized ? <Copy size={13} strokeWidth={1.6} /> : <Square size={12} strokeWidth={1.6} />}
        </button>
        <button
          className="desktop-window-controls__close"
          type="button"
          aria-label="Close window"
          title="Close"
          onClick={requestClose}
        >
          <span><X size={14} strokeWidth={2} /></span>
        </button>
      </div>

      {confirmClose ? createPortal(
        <div className="modal-scrim" role="presentation" onMouseDown={() => setConfirmClose(false)}>
          <section
            className="close-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="close-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <span className="close-confirmation__icon"><AlertTriangle size={21} /></span>
            <div>
              <p>Unsaved score changes</p>
              <h2 id="close-dialog-title">Close the operational system?</h2>
              <span>Your pending stack edits have not been committed. You can return and save them first.</span>
            </div>
            <div className="close-confirmation__actions">
              <button className="secondary-button" type="button" onClick={() => setConfirmClose(false)}>Keep working</button>
              <button className="danger-button" type="button" onClick={() => void window.nplWindowClose?.()}>Discard and close</button>
            </div>
          </section>
        </div>,
        document.body,
      ) : null}
    </>
  )
}

function StaffLoginDialog({
  challenge,
  loading,
  error,
  secondsRemaining,
  onClose,
  onRegenerate,
}: {
  challenge: StaffLoginChallenge | null
  loading: boolean
  error: string | null
  secondsRemaining: number
  onClose: () => void
  onRegenerate: () => void
}) {
  const statusLabel = challenge?.status === "scanned"
    ? "Phone connected"
    : challenge?.status === "approved"
      ? "Sign-in approved"
      : challenge?.status === "expired"
        ? "Request expired"
        : challenge?.status === "locked"
          ? "Request locked"
          : "Waiting for scan"

  let gatewayLabel = "Private venue network"
  if (challenge?.login_url) {
    try {
      gatewayLabel = new URL(challenge.login_url).origin.replace(/^https?:\/\//, "")
    } catch {
      gatewayLabel = "Private venue network"
    }
  }

  const terminal = challenge?.status === "expired" ||
    challenge?.status === "cancelled" ||
    challenge?.status === "locked"

  return (
    <div className="modal-scrim staff-login-scrim" role="presentation" onMouseDown={onClose}>
      <section
        className="staff-login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="staff-login-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="staff-login-dialog__header">
          <span className="staff-login-dialog__icon"><QrCode size={24} /></span>
          <div>
            <p>Secure staff access</p>
            <h2 id="staff-login-title">Scan to sign in on a staff phone</h2>
          </div>
          <button className="staff-login-dialog__close" type="button" aria-label="Close staff login" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {loading ? (
          <div className="staff-login-dialog__loading" role="status">
            <RefreshCw size={30} />
            <strong>Creating a protected login request</strong>
            <span>Detecting the private venue gateway…</span>
          </div>
        ) : error ? (
          <div className="staff-login-dialog__error">
            <AlertTriangle size={30} />
            <h3>Staff QR is not available</h3>
            <p>{error}</p>
            <button className="primary-button" type="button" onClick={onRegenerate}>
              <RefreshCw size={17} /> Try again
            </button>
          </div>
        ) : challenge?.status === "approved" && challenge.staff ? (
          <div className="staff-login-approved">
            <span className="staff-login-approved__check"><CheckCircle2 size={48} /></span>
            <p>Phone session active</p>
            <h3>{challenge.staff.name}</h3>
            <span>{challenge.staff.role} · {challenge.staff.id}</span>
            <div className="staff-login-approved__security">
              <ShieldCheck size={18} />
              <span>The one-time QR has been consumed and cannot be replayed.</span>
            </div>
            <button className="primary-button" type="button" onClick={onClose}>Done</button>
          </div>
        ) : challenge ? (
          <>
            <div className="staff-login-dialog__body">
              <div className={terminal ? "staff-qr-card staff-qr-card--inactive" : "staff-qr-card"}>
                {!terminal ? (
                  <QRCodeSVG
                    value={challenge.login_url}
                    size={236}
                    level="M"
                    marginSize={2}
                    bgColor="#ffffff"
                    fgColor="#07142b"
                    title="NPL one-time staff login QR code"
                  />
                ) : (
                  <div className="staff-qr-card__inactive">
                    <QrCode size={54} />
                    <span>Generate a new request</span>
                  </div>
                )}
                <div className={`staff-qr-status staff-qr-status--${challenge.status}`}>
                  <i />
                  <span>{statusLabel}</span>
                </div>
              </div>

              <div className="staff-login-instructions">
                <div className="staff-login-instructions__step">
                  <span>1</span>
                  <div>
                    <strong>Scan with the staff phone</strong>
                    <p>The phone must be connected to the same private venue network.</p>
                  </div>
                </div>
                <div className="staff-login-instructions__step">
                  <span>2</span>
                  <div>
                    <strong>Enter this pairing code</strong>
                    <p className="staff-pairing-code" aria-label={`Pairing code ${challenge.pairing_code}`}>
                      {challenge.pairing_code}
                    </p>
                  </div>
                </div>
                <div className="staff-login-instructions__step">
                  <span>3</span>
                  <div>
                    <strong>Confirm staff identity</strong>
                    <p>NPL OS will show the approved staff member automatically.</p>
                  </div>
                </div>

                <div className="staff-gateway-status">
                  <Smartphone size={18} />
                  <div>
                    <span>Private staff gateway</span>
                    <strong>{gatewayLabel}</strong>
                  </div>
                  <ShieldCheck size={18} />
                </div>
              </div>
            </div>

            <footer className="staff-login-dialog__footer">
              <div>
                <span className={secondsRemaining <= 30 ? "staff-login-timer staff-login-timer--urgent" : "staff-login-timer"}>
                  {terminal ? statusLabel : `${Math.floor(secondsRemaining / 60)}:${String(secondsRemaining % 60).padStart(2, "0")} remaining`}
                </span>
                <small>One-time token · 5 attempt limit · 8-hour phone session</small>
              </div>
              <button className="secondary-button" type="button" onClick={onRegenerate}>
                <RefreshCw size={17} /> New QR
              </button>
            </footer>
          </>
        ) : null}
      </section>
    </div>
  )
}

function SidebarStaffQR({
  visible,
  challenge,
  loading,
  error,
  secondsRemaining,
  onHide,
  onShow,
  onRefresh,
}: {
  visible: boolean
  challenge: StaffLoginChallenge | null
  loading: boolean
  error: string | null
  secondsRemaining: number
  onHide: () => void
  onShow: () => void
  onRefresh: () => void
}) {
  if (!visible) {
    return (
      <section className="sidebar-staff-qr sidebar-staff-qr--hidden" aria-label="Staff login QR hidden">
        <span className="sidebar-staff-qr__symbol"><QrCode size={20} /></span>
        <div>
          <strong>Staff login</strong>
          <span>QR code hidden</span>
        </div>
        <button type="button" onClick={onShow} aria-label="Show staff login QR code">
          <Eye size={17} /> Show
        </button>
      </section>
    )
  }

  const approved = challenge?.status === "approved" && challenge.staff
  const active = challenge?.status === "waiting" || challenge?.status === "scanned"
  const statusLabel = challenge?.status === "scanned"
    ? "Phone connected"
    : challenge?.status === "approved"
      ? "Sign-in approved"
      : "Ready to scan"

  return (
    <section className="sidebar-staff-qr" aria-label="Staff phone login QR code">
      <header>
        <div>
          <span><i /> Staff login</span>
          <strong>{statusLabel}</strong>
        </div>
        <button type="button" onClick={onHide} aria-label="Hide staff login QR code">
          <EyeOff size={16} /> Hide
        </button>
      </header>

      {loading ? (
        <div className="sidebar-staff-qr__state" role="status">
          <RefreshCw size={25} />
          <strong>Preparing secure QR…</strong>
        </div>
      ) : error ? (
        <div className="sidebar-staff-qr__state sidebar-staff-qr__state--error">
          <AlertTriangle size={24} />
          <strong>QR unavailable</strong>
          <button type="button" onClick={onRefresh}>Try again</button>
        </div>
      ) : approved ? (
        <div className="sidebar-staff-qr__approved">
          <CheckCircle2 size={35} />
          <strong>{challenge.staff?.name}</strong>
          <span>Phone session approved</span>
        </div>
      ) : challenge && active ? (
        <>
          <div className="sidebar-staff-qr__code">
            <QRCodeSVG
              value={challenge.login_url}
              size={164}
              level="M"
              marginSize={1}
              bgColor="#ffffff"
              fgColor="#07142b"
              title="NPL one-time staff login QR code"
            />
          </div>
          <div className="sidebar-staff-qr__pairing">
            <span>Pairing code</span>
            <strong>{challenge.pairing_code}</strong>
          </div>
          <footer>
            <span>{Math.floor(secondsRemaining / 60)}:{String(secondsRemaining % 60).padStart(2, "0")}</span>
            <small>{challenge.status === "scanned" ? "Confirm on phone" : "Same venue Wi-Fi"}</small>
            <button type="button" onClick={onRefresh} aria-label="Generate a new staff QR code" title="New QR">
              <RefreshCw size={15} />
            </button>
          </footer>
        </>
      ) : (
        <div className="sidebar-staff-qr__state">
          <QrCode size={25} />
          <strong>Refreshing QR…</strong>
        </div>
      )}
    </section>
  )
}

export default function App() {
  // A venue can pin a desktop shortcut straight to the station this laptop
  // is used for — the door scanner opens on Host, the floor opens on tables.
  const [activeSection, setActiveSection] = useState<NavId>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab") ?? ""
    const resolved = legacyTabIds[requested] ?? requested
    const known = navigation.flatMap((group) => group.items).some((item) => item.id === resolved)
    return known ? (resolved as NavId) : "overview"
  })
  const [selectedTableId, setSelectedTableId] = useState(tables[0].id)
  const [health, setHealth] = useState<HealthState>({ status: "loading" })
  const [networkQuality, setNetworkQuality] = useState<NetworkQualityState>({ status: "loading" })
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false)
  const [networkRefreshing, setNetworkRefreshing] = useState(false)
  const [manualUpdating, setManualUpdating] = useState(false)
  const [avatarSyncing, setAvatarSyncing] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // The venue scopes the whole console. It is remembered across restarts
  // because a laptop lives at one club — re-picking it every morning would
  // just be a chance to pick the wrong one.
  const [venues, setVenues] = useState<Venue[]>([])
  const [venueId, setVenueId] = useState<number | null>(() => {
    const stored = window.localStorage.getItem("npl.activeVenueId")
    return stored ? Number(stored) : null
  })
  const [venueMenuOpen, setVenueMenuOpen] = useState(false)
  const activeVenue = venues.find((venue) => venue.id === venueId) ?? null

  useEffect(() => {
    void deskApi.venues()
      .then((result) => {
        setVenues(result.venues)
        // A single-venue install should not have to choose.
        if (result.venues.length === 1) {
          setVenueId((current) => current ?? result.venues[0].id)
        }
      })
      .catch(() => setVenues([]))
  }, [])

  useEffect(() => {
    if (venueId === null) window.localStorage.removeItem("npl.activeVenueId")
    else window.localStorage.setItem("npl.activeVenueId", String(venueId))
  }, [venueId])
  const [paused, setPaused] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [startupPhase, setStartupPhase] = useState<"visible" | "leaving" | "hidden">("visible")
  const [notificationOpen, setNotificationOpen] = useState(false)
  const [staffQRVisible, setStaffQRVisible] = useState(true)
  const [staffLoginLoading, setStaffLoginLoading] = useState(false)
  const [staffLoginError, setStaffLoginError] = useState<string | null>(null)
  const [staffChallenge, setStaffChallenge] = useState<StaffLoginChallenge | null>(null)
  const [staffSecondsRemaining, setStaffSecondsRemaining] = useState(0)
  const [activeStaff, setActiveStaff] = useState<StaffIdentity>({
    id: "NPL-1001",
    name: "Kyle Chen",
    role: "Floor Manager",
    initials: "KC",
  })
  const [stackEdits, setStackEdits] = useState<{
    changes: Record<string, number>
    history: Array<{ key: string; previous: number }>
  }>({ changes: {}, history: [] })

  const stackChanges = stackEdits.changes
  const pendingChangeCount = Object.values(stackChanges).filter((change) => change !== 0).length

  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? tables[0],
    [selectedTableId],
  )

  const loadHealth = useCallback(async () => {
    setHealth({ status: "loading" })
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error("Health endpoint unavailable")
      setHealth({ status: "ready", health: (await response.json()) as Health })
    } catch {
      setHealth({ status: "error" })
    }
  }, [])

  const loadNetworkQuality = useCallback(async (manual = false) => {
    if (manual) setNetworkRefreshing(true)
    try {
      const endpoint = manual ? "/api/network-quality?refresh=1" : "/api/network-quality"
      const response = await fetch(endpoint, { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error("Network quality endpoint unavailable")
      setNetworkQuality({ status: "ready", quality: (await response.json()) as NetworkQuality })
    } catch {
      setNetworkQuality({ status: "error" })
    } finally {
      if (manual) setNetworkRefreshing(false)
    }
  }, [])

  const cancelStaffChallenge = useCallback(async (challenge: StaffLoginChallenge | null) => {
    if (!challenge || challenge.status === "approved" || challenge.status === "expired" || challenge.status === "cancelled") return
    try {
      await fetch(`/api/staff-login/challenges/${encodeURIComponent(challenge.id)}`, {
        method: "DELETE",
        headers: { Accept: "application/json" },
      })
    } catch {
      // Expiry still bounds a request if the local gateway closes mid-cancel.
    }
  }, [])

  const createStaffChallenge = useCallback(async (previous?: StaffLoginChallenge | null) => {
    if (previous) await cancelStaffChallenge(previous)
    setStaffLoginLoading(true)
    setStaffLoginError(null)
    setStaffChallenge(null)
    try {
      const response = await fetch("/api/staff-login/challenges", {
        method: "POST",
        headers: { Accept: "application/json" },
      })
      const payload = await response.json() as StaffLoginChallenge & { error?: string }
      if (!response.ok) throw new Error(payload.error || "The private staff gateway could not create a login request.")
      setStaffChallenge(payload)
      setStaffSecondsRemaining(payload.seconds_remaining)
    } catch (requestError) {
      setStaffLoginError(
        requestError instanceof Error
          ? requestError.message
          : "The private staff gateway could not create a login request.",
      )
    } finally {
      setStaffLoginLoading(false)
    }
  }, [cancelStaffChallenge])

  const hideStaffQR = () => {
    void cancelStaffChallenge(staffChallenge)
    setStaffQRVisible(false)
    setStaffLoginError(null)
    setStaffChallenge(null)
  }

  const showStaffQR = () => {
    setStaffQRVisible(true)
    void createStaffChallenge()
  }

  const regenerateStaffLogin = () => {
    void createStaffChallenge(staffChallenge)
  }

  useEffect(() => {
    void loadHealth()
  }, [loadHealth])

  useEffect(() => {
    void createStaffChallenge()
  }, [createStaffChallenge])

  useEffect(() => {
    if (!staffQRVisible || !staffChallenge) return
    if (staffChallenge.status !== "waiting" && staffChallenge.status !== "scanned") return

    let stopped = false
    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/staff-login/challenges/${encodeURIComponent(staffChallenge.id)}`, {
          headers: { Accept: "application/json", "Cache-Control": "no-store" },
        })
        if (!response.ok) return
        const status = await response.json() as Pick<
          StaffLoginChallenge,
          "id" | "status" | "expires_at" | "seconds_remaining" | "staff"
        >
        if (stopped) return
        setStaffChallenge((current) => current?.id === status.id ? { ...current, ...status } : current)
        setStaffSecondsRemaining(status.seconds_remaining)
        if (status.status === "approved" && status.staff) {
          setActiveStaff(status.staff)
          setNotice(`${status.staff.name} signed in securely from a staff phone.`)
        }
      } catch {
        // Keep the displayed QR active; the next lightweight poll can recover.
      }
    }

    void pollStatus()
    const poll = window.setInterval(pollStatus, 1_500)
    return () => {
      stopped = true
      window.clearInterval(poll)
    }
  }, [staffQRVisible, staffChallenge?.id, staffChallenge?.status])

  useEffect(() => {
    if (!staffQRVisible || !staffChallenge) return
    const updateCountdown = () => {
      const remaining = Math.max(0, Math.ceil((new Date(staffChallenge.expires_at).getTime() - Date.now()) / 1000))
      setStaffSecondsRemaining(remaining)
    }
    updateCountdown()
    const timer = window.setInterval(updateCountdown, 1_000)
    return () => window.clearInterval(timer)
  }, [staffQRVisible, staffChallenge?.id, staffChallenge?.expires_at])

  useEffect(() => {
    if (!staffQRVisible || !staffChallenge || staffChallenge.status !== "approved") return
    const nextStaff = window.setTimeout(() => {
      void createStaffChallenge(staffChallenge)
    }, 4_500)
    return () => window.clearTimeout(nextStaff)
  }, [staffQRVisible, staffChallenge?.id, staffChallenge?.status, createStaffChallenge])

  useEffect(() => {
    if (!staffQRVisible || !staffChallenge || staffSecondsRemaining > 0) return
    if (staffChallenge.status !== "waiting" && staffChallenge.status !== "scanned") return
    const rotateExpired = window.setTimeout(() => {
      void createStaffChallenge(staffChallenge)
    }, 500)
    return () => window.clearTimeout(rotateExpired)
  }, [staffQRVisible, staffChallenge?.id, staffChallenge?.status, staffSecondsRemaining, createStaffChallenge])

  useEffect(() => {
    void loadNetworkQuality()
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadNetworkQuality()
    }, 30_000)
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadNetworkQuality()
    }
    document.addEventListener("visibilitychange", refreshWhenVisible)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
    }
  }, [loadNetworkQuality])

  useEffect(() => {
    if (health.status === "loading") return
    const beginExit = window.setTimeout(() => setStartupPhase("leaving"), 1800)
    const finishExit = window.setTimeout(() => setStartupPhase("hidden"), 2100)
    return () => {
      window.clearTimeout(beginExit)
      window.clearTimeout(finishExit)
    }
  }, [health.status])

  useEffect(() => {
    if (!notice) return
    const timeout = window.setTimeout(() => setNotice(null), 3200)
    return () => window.clearTimeout(timeout)
  }, [notice])

  useEffect(() => {
    const handleGlobalShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false)
        setConnectionPanelOpen(false)
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut)
    return () => window.removeEventListener("keydown", handleGlobalShortcut)
  }, [])

  const adjustStack = (player: Player, delta: number) => {
    const key = `${selectedTable.id}-${player.seat}`
    setStackEdits((current) => {
      const previous = current.changes[key] ?? 0
      const next = Math.max(-player.stack, previous + delta)
      if (next === previous) return current

      return {
        changes: { ...current.changes, [key]: next },
        history: [...current.history, { key, previous }],
      }
    })
  }

  const undoStackEdit = () => {
    setStackEdits((current) => {
      const last = current.history.at(-1)
      if (!last) return current
      const changes = { ...current.changes }
      if (last.previous === 0) delete changes[last.key]
      else changes[last.key] = last.previous
      return { changes, history: current.history.slice(0, -1) }
    })
  }

  const saveStackEdits = () => {
    if (pendingChangeCount === 0) return
    setNotice(`${pendingChangeCount} score ${pendingChangeCount === 1 ? "change" : "changes"} committed locally.`)
    setStackEdits({ changes: {}, history: [] })
  }

  const chooseSection = (id: NavId) => {
    setActiveSection(id)
    setMobileNavOpen(false)
  }

  const syncAvatars = async () => {
    if (avatarSyncing) return
    setAvatarSyncing(true)

    try {
      const result = await syncApi.avatars()
      const installed = Number(result.avatars.installed ?? 0)
      setNotice(installed > 0
        ? `${installed} player ${installed === 1 ? "avatar" : "avatars"} installed.`
        : "Avatars are already up to date.")
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Avatars could not be synced.")
    } finally {
      setAvatarSyncing(false)
    }
  }

  const runManualUpdate = async () => {
    if (manualUpdating) return
    setManualUpdating(true)

    try {
      const { run: started } = await syncApi.run("console")
      const run = await syncApi.awaitRun(started, (progress) => {
        setNotice(`Updating… ${progress.progress}% (${progress.stage ?? "starting"})`)
      })
      setNotice(describeRun(run))

      // Venues and sessions may have changed underneath the header picker,
      // so re-read them rather than leaving a stale list on screen.
      const venueResult = await deskApi.venues()
      setVenues(venueResult.venues)
      setVenueId((current) => {
        if (current !== null && venueResult.venues.some((entry) => entry.id === current)) return current
        return venueResult.venues.length === 1 ? venueResult.venues[0].id : current
      })
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The update could not be completed.")
    } finally {
      setManualUpdating(false)
      void Promise.all([loadHealth(), loadNetworkQuality(true)])
    }
  }

  const handleUnifiedHeaderPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (event.button !== 0 || target.closest("button, input, kbd, [role='dialog']")) return

    if (event.detail === 2) {
      void window.nplWindowToggleMaximize?.()
      return
    }

    void window.nplWindowStartDrag?.()
  }

  return (
    <div className="desktop-frame">
      <div className="app-shell">
      <div className="ambient-grid" aria-hidden="true" />
      <button
        className={mobileNavOpen ? "nav-backdrop nav-backdrop--visible" : "nav-backdrop"}
        type="button"
        aria-label="Close navigation"
        tabIndex={mobileNavOpen ? 0 : -1}
        onClick={() => setMobileNavOpen(false)}
      />

      <aside className={mobileNavOpen ? "sidebar sidebar--open" : "sidebar"}>
        <div className="brand-lockup" onPointerDown={handleUnifiedHeaderPointerDown}>
          <div className="brand-mark" aria-hidden="true">
            <img src={nplLogoUrl} alt="" />
          </div>
          <div className="brand-copy">
            <strong>NPL</strong>
            <span>OS</span>
          </div>
          <button
            className="sidebar-close icon-button"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <ConnectionSignal
          state={networkQuality}
          expanded={connectionPanelOpen}
          refreshing={networkRefreshing}
          onToggle={() => setConnectionPanelOpen((current) => !current)}
          onRefresh={() => void loadNetworkQuality(true)}
        />

        <div className="sidebar-menu-container">
          <nav className="primary-nav" aria-label="Operational system navigation">
            {navigation.map((group) => (
              <div className="nav-group" key={group.label}>
                <p>{group.label}</p>
                {group.items.map((item) => {
                  const Icon = item.icon
                  const active = activeSection === item.id
                  return (
                    <button
                      className={active ? "nav-item nav-item--active" : "nav-item"}
                      type="button"
                      key={item.id}
                      aria-current={active ? "page" : undefined}
                      onClick={() => chooseSection(item.id)}
                    >
                      <Icon size={18} strokeWidth={1.8} />
                      <span>{item.label}</span>
                      {item.badge ? <strong>{item.badge}</strong> : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        </div>

        <SidebarStaffQR
          visible={staffQRVisible}
          challenge={staffChallenge}
          loading={staffLoginLoading}
          error={staffLoginError}
          secondsRemaining={staffSecondsRemaining}
          onHide={hideStaffQR}
          onShow={showStaffQR}
          onRefresh={regenerateStaffLogin}
        />

        <div className="operator-card">
          <div className="operator-avatar">{activeStaff.initials}</div>
          <div>
            <strong>{activeStaff.name}</strong>
            <span>{activeStaff.role}</span>
          </div>
          <button
            className="operator-action"
            type="button"
            aria-label="Sign out staff phone session"
            title="Clear paired staff"
            onClick={() => {
              setActiveStaff({
                id: "NPL-LOCAL",
                name: "Local operator",
                role: "Staff access ready",
                initials: "NPL",
              })
              setNotice("The paired staff identity was cleared from this console.")
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar" onPointerDown={handleUnifiedHeaderPointerDown}>
          <div className="topbar-left">
            <button
              className="mobile-menu icon-button"
              type="button"
              aria-label="Open navigation"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div className="venue-selector-wrap">
              <button
                className="venue-selector"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={venueMenuOpen}
                onClick={() => setVenueMenuOpen((open) => !open)}
              >
                <span className="venue-icon"><Spade size={15} /></span>
                <span>
                  <small>Active venue</small>
                  {activeVenue?.name ?? (venues.length ? "Choose a venue" : "No venues synced")}
                </span>
                <ChevronDown size={16} />
              </button>

              {venueMenuOpen ? (
                <ul className="venue-menu" role="listbox" aria-label="Venues">
                  {venues.length === 0 ? (
                    <li className="venue-menu__empty">Run a manual update to pull venues.</li>
                  ) : venues.map((venue) => (
                    <li key={venue.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={venue.id === venueId}
                        className={venue.id === venueId ? "is-active" : undefined}
                        onClick={() => {
                          setVenueId(venue.id)
                          setVenueMenuOpen(false)
                        }}
                      >
                        <strong>{venue.name}</strong>
                        <small>{[venue.suburb, venue.state_code].filter(Boolean).join(", ")}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>

          <div className="topbar-right">
            <button
              className={manualUpdating ? "manual-update-button manual-update-button--active" : "manual-update-button"}
              type="button"
              aria-label={manualUpdating ? "Updating operations data" : "Update operations data manually"}
              disabled={manualUpdating}
              onClick={() => void runManualUpdate()}
            >
              <RefreshCw size={18} />
              <span>{manualUpdating ? "Updating…" : "Manual update"}</span>
            </button>
            <button
              className={avatarSyncing ? "avatar-sync-button avatar-sync-button--active" : "avatar-sync-button"}
              type="button"
              aria-label={avatarSyncing ? "Syncing player avatars" : "Sync player avatars manually"}
              disabled={avatarSyncing}
              onClick={() => void syncAvatars()}
            >
              <Users size={18} />
              <span>{avatarSyncing ? "Syncing avatars…" : "Sync avatars"}</span>
            </button>
            <div className="notification-wrap">
              <button
                className={notificationOpen ? "icon-button notification-button notification-button--active" : "icon-button notification-button"}
                type="button"
                aria-label="Notifications"
                aria-expanded={notificationOpen}
                onClick={() => {
                  setNotificationOpen((current) => !current)
                }}
              >
                <Bell size={18} />
                <span />
              </button>
            </div>
            <DesktopWindowControls hasPendingChanges={pendingChangeCount > 0} />
          </div>
        </header>

        <div className={notificationOpen ? "app-content app-content--notification-open" : "app-content"}>
          <main className="workspace">
            {activeSection === "tournament" ? (
              <HostWorkspace venue={activeVenue} />
            ) : activeSection === "jackpot" ? (
              <JackpotWheelWorkspace />
            ) : activeSection === "overview" ? (
              <OverviewWorkspace onNotice={setNotice} />
            ) : activeSection === "cashgame" ? (
              <CashGameWorkspace
                selectedTable={selectedTable}
                selectedTableId={selectedTableId}
                paused={paused}
                stackChanges={stackChanges}
                onSelectTable={setSelectedTableId}
                onAdjustStack={adjustStack}
                pendingChangeCount={pendingChangeCount}
                canUndo={stackEdits.history.length > 0}
                onUndo={undoStackEdit}
                onSave={saveStackEdits}
                onTogglePause={() => setPaused((current) => !current)}
                onNotice={setNotice}
              />
            ) : (
              <ModulePreview id={activeSection} onNotice={setNotice} />
            )}
          </main>

          {notificationOpen ? <NotificationSession onNavigate={chooseSection} /> : null}
        </div>

        <footer className="statusbar">
          <div>
            <span className={`health-dot health-dot--${health.status}`} />
            <span>Local services {health.status === "ready" ? "operational" : health.status}</span>
          </div>
          <div>
            <span>Last sync <strong>just now</strong></span>
            <span className="statusbar-divider" />
            <span>{health.status === "ready" ? `Build ${health.health.version}` : "Build —"}</span>
          </div>
        </footer>
      </div>

      {notice ? (
        <div className="toast" role="status">
          <span><ShieldCheck size={18} /></span>
          <div>
            <strong>Action captured</strong>
            <p>{notice}</p>
          </div>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      ) : null}
      </div>
      {startupPhase !== "hidden" ? <StartupScreen leaving={startupPhase === "leaving"} /> : null}
    </div>
  )
}

const notificationEvents: Array<{
  id: string
  title: string
  detail: string
  time: string
  section: NavId
  icon: LucideIcon
  tone: "registration" | "warning" | "info" | "success" | "gold"
}> = [
  {
    id: "registration-olivia",
    title: "Olivia Moore registered",
    detail: "Main Event · Registration confirmed",
    time: "Just now",
    section: "registrations",
    icon: UserPlus,
    tone: "registration",
  },
  {
    id: "waitlist-six",
    title: "Six players are waiting",
    detail: "Longest wait is now 11 minutes",
    time: "2 min",
    section: "registrations",
    icon: Users,
    tone: "info",
  },
  {
    id: "table-04-paused",
    title: "Table 04 is paused",
    detail: "East Wing · Operator attention required",
    time: "4 min",
    section: "cashgame",
    icon: Pause,
    tone: "warning",
  },
  {
    id: "rebuy-ethan",
    title: "Rebuy recorded",
    detail: "Ethan Wong · Table 03 · $500",
    time: "8 min",
    section: "cashgame",
    icon: CircleDollarSign,
    tone: "gold",
  },
  {
    id: "jackpot-pool",
    title: "Jackpot pool climbed to $4,820",
    detail: "Backed by tonight's desk entries",
    time: "12 min",
    section: "jackpot",
    icon: LoaderPinwheel,
    tone: "gold",
  },
  {
    id: "avatars-synced",
    title: "Player avatars synchronized",
    detail: "47 active player records updated",
    time: "18 min",
    section: "players",
    icon: Users,
    tone: "registration",
  },
  {
    id: "membership-prints",
    title: "Nine club cards queued to print",
    detail: "Club Membership ID · Next batch",
    time: "22 min",
    section: "membership",
    icon: IdCard,
    tone: "info",
  },
]

function NotificationSession({ onNavigate }: { onNavigate: (id: NavId) => void }) {
  return (
    <aside className="notification-session" aria-label="Persistent operations notification session">
      <header>
        <div className="notification-session__heading">
          <span><Bell size={19} /></span>
          <div>
            <p>Live operations</p>
            <h2>Notification session</h2>
          </div>
        </div>
        <strong>{notificationEvents.length}</strong>
      </header>

      <div className="notification-session__status">
        <span><Activity size={16} /> Current session</span>
        <small>Stays open while you work</small>
      </div>

      <div className="notification-session__day">Today</div>

      <div className="notification-stream">
        {notificationEvents.map((event) => {
          const Icon = event.icon
          return (
            <button
              className={`notification-item notification-item--${event.tone}`}
              type="button"
              key={event.id}
              onClick={() => onNavigate(event.section)}
            >
              <span><Icon size={19} /></span>
              <div>
                <strong>{event.title}</strong>
                <small>{event.detail}</small>
                <time>{event.time}</time>
              </div>
              <ChevronDown size={17} />
            </button>
          )
        })}
      </div>

      <footer>
        <ShieldCheck size={16} />
        <span>Notifications remain visible until you press the bell again.</span>
      </footer>
    </aside>
  )
}

type CashGameWorkspaceProps = {
  selectedTable: GameTable
  selectedTableId: string
  paused: boolean
  stackChanges: Record<string, number>
  onSelectTable: (id: string) => void
  onAdjustStack: (player: Player, delta: number) => void
  pendingChangeCount: number
  canUndo: boolean
  onUndo: () => void
  onSave: () => void
  onTogglePause: () => void
  onNotice: (message: string) => void
}

function CashGameWorkspace({
  selectedTable,
  selectedTableId,
  paused,
  stackChanges,
  onSelectTable,
  onAdjustStack,
  pendingChangeCount,
  canUndo,
  onUndo,
  onSave,
  onTogglePause,
  onNotice,
}: CashGameWorkspaceProps) {
  const title = moduleTitles.cashgame

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{title.eyebrow}</p>
          <h1>{title.title}</h1>
          <p className="page-description">{title.description}</p>
        </div>
        <div className="page-actions">
          <button className="secondary-button" type="button" onClick={() => onNotice("The table export is ready for backend wiring.")}>
            <RefreshCw size={16} />
            Sync floor
          </button>
          <button className="primary-button" type="button" onClick={() => onNotice("New table setup is ready for backend wiring.")}>
            <Plus size={17} />
            Start new table
          </button>
        </div>
      </div>

      <section className="metric-grid" aria-label="Venue summary">
        <MetricCard icon={Table2} label="Active tables" value="5" note="4 live · 1 seating" tone="cyan" />
        <MetricCard icon={Users} label="Players seated" value="43" note="86% floor capacity" tone="blue" />
        <MetricCard icon={ListChecks} label="Waitlist" value="6" note="Longest wait 11 min" tone="gold" />
        <MetricCard icon={CircleDollarSign} label="Buy-ins tonight" value="$12.5k" note="+18% vs last Tuesday" tone="green" />
      </section>

      <section className="table-switcher" aria-label="Select table">
        <div className="table-switcher-heading">
          <div>
            <span className="live-indicator" />
            Floor status
          </div>
          <button type="button" aria-label="More table options"><MoreHorizontal size={18} /></button>
        </div>
        <div className="table-tabs">
          {tables.map((table) => (
            <button
              className={table.id === selectedTableId ? "table-tab table-tab--active" : "table-tab"}
              type="button"
              key={table.id}
              aria-pressed={table.id === selectedTableId}
              onClick={() => onSelectTable(table.id)}
            >
              <span>Table {table.number}</span>
              <strong>{table.name}</strong>
              <small>
                <i className={`table-status-dot table-status-dot--${table.status.toLowerCase()}`} />
                {table.status} · {table.players.length}/8
              </small>
            </button>
          ))}
        </div>
      </section>

      <div className="operations-layout">
        <section className="panel score-panel">
          <header className="panel-header score-panel-header">
            <div className="table-identity">
              <span className="table-number">{selectedTable.number}</span>
              <div>
                <p>{selectedTable.game}</p>
                <h2>{selectedTable.name}</h2>
              </div>
            </div>
            <div className="table-meta">
              <span><Gauge size={15} /> {selectedTable.blinds}</span>
              <span><Clock3 size={15} /> {selectedTable.elapsed}</span>
              <span className={paused ? "state-chip state-chip--paused" : "state-chip"}>
                <i />
                {paused ? "Paused" : selectedTable.status}
              </span>
            </div>
          </header>

          <div className="hand-strip">
            <div>
              <small>Current hand</small>
              <strong>#{selectedTable.hand || "—"}</strong>
            </div>
            <div>
              <small>Players</small>
              <strong>{selectedTable.players.length} / 8</strong>
            </div>
            <div>
              <small>Chips in play</small>
              <strong>{money(selectedTable.players.reduce((total, player) => total + player.stack, 0))}</strong>
            </div>
            <button className={paused ? "round-button round-button--resume" : "round-button"} type="button" onClick={onTogglePause}>
              {paused ? <Play size={16} /> : <Pause size={16} />}
              {paused ? "Resume table" : "Pause table"}
            </button>
          </div>

          <div className="score-table-wrap">
            <table className="score-table">
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Player</th>
                  <th>Buy-in</th>
                  <th>Rebuys</th>
                  <th>Stack</th>
                  <th>Net</th>
                  <th><span className="visually-hidden">Stack controls</span></th>
                </tr>
              </thead>
              <tbody>
                {selectedTable.players.map((player) => {
                  const key = `${selectedTable.id}-${player.seat}`
                  const currentStack = player.stack + (stackChanges[key] ?? 0)
                  const net = currentStack - player.invested

                  return (
                    <tr className={stackChanges[key] ? "score-row score-row--edited" : "score-row"} key={player.seat}>
                      <td>
                        <span className="seat-number">{player.seat}</span>
                        {player.dealer ? <span className="dealer-chip">D</span> : null}
                      </td>
                      <td>
                        <div className="player-cell">
                          <span>{player.name.split(" ").map((part) => part[0]).join("")}</span>
                          <div>
                            <strong>{player.name}</strong>
                            <small>{player.nplId}</small>
                          </div>
                        </div>
                      </td>
                      <td>{money(player.invested)}</td>
                      <td>{player.rebuys}</td>
                      <td className="stack-value">
                        <span>{money(currentStack)}</span>
                        {stackChanges[key] ? <small>Edited</small> : null}
                      </td>
                      <td className={net >= 0 ? "net-positive" : "net-negative"}>
                        {net >= 0 ? "+" : "−"}{money(Math.abs(net))}
                      </td>
                      <td>
                        <div className="stack-controls">
                          <button type="button" aria-label={`Subtract 20 from ${player.name}`} onClick={() => onAdjustStack(player, -20)}>
                            <Minus size={14} />
                          </button>
                          <button type="button" aria-label={`Add 20 to ${player.name}`} onClick={() => onAdjustStack(player, 20)}>
                            <Plus size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {Array.from({ length: Math.max(0, 8 - selectedTable.players.length) }, (_, index) => (
                  <tr className="empty-seat-row" key={`empty-${index}`}>
                    <td><span className="seat-number">{selectedTable.players.length + index + 1}</span></td>
                    <td colSpan={5}>
                      <button type="button" onClick={() => onNotice("Player seating is ready for backend wiring.")}>
                        <UserPlus size={15} />
                        Seat available
                      </button>
                    </td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="score-panel-footer">
            <div className={pendingChangeCount ? "score-save-state score-save-state--pending" : "score-save-state"}>
              <span>
                {pendingChangeCount
                  ? `${pendingChangeCount} score ${pendingChangeCount === 1 ? "change" : "changes"} pending`
                  : "All score changes saved locally"}
              </span>
            </div>
            <div className="score-footer-actions">
              {pendingChangeCount ? (
                <>
                  <button className="undo-button" type="button" disabled={!canUndo} onClick={onUndo}>
                    <Undo2 size={14} />
                    Undo
                  </button>
                  <button className="save-button" type="button" onClick={onSave}>
                    <Save size={14} />
                    Save changes
                  </button>
                </>
              ) : null}
              <button className="close-table-button" type="button" onClick={() => onNotice("Table close flow is ready for backend wiring.")}>Close table</button>
            </div>
          </div>
        </section>

        <aside className="right-rail">
          <section className="panel quick-actions">
            <header className="panel-header compact-panel-header">
              <div>
                <p>Table controls</p>
                <h2>Quick actions</h2>
              </div>
              <ShieldCheck size={18} />
            </header>
            <div className="quick-action-grid">
              <button type="button" onClick={() => onNotice("Player check-in opened.")}><UserPlus size={18} /><span>Add player</span></button>
              <button type="button" onClick={() => onNotice("Seat move opened.")}><Users size={18} /><span>Move seat</span></button>
              <button type="button" onClick={() => onNotice("Rebuy recorded locally.")}><CircleDollarSign size={18} /><span>Add rebuy</span></button>
              <button type="button" onClick={() => onNotice("Result review opened.")}><Medal size={18} /><span>Result</span></button>
            </div>
          </section>

          <section className="panel waitlist-panel">
            <header className="panel-header compact-panel-header">
              <div>
                <p>Live queue</p>
                <h2>Waitlist</h2>
              </div>
              <span className="count-chip">6</span>
            </header>
            <ol className="waitlist">
              <li>
                <span>01</span>
                <div><strong>Lucas Kim</strong><small>NPL-05172 · 11 min</small></div>
                <button type="button" aria-label="Seat Lucas Kim" onClick={() => onNotice("Lucas Kim selected for seating.")}><ChevronDown size={15} /></button>
              </li>
              <li>
                <span>02</span>
                <div><strong>Ruby Taylor</strong><small>NPL-02619 · 8 min</small></div>
                <button type="button" aria-label="Seat Ruby Taylor" onClick={() => onNotice("Ruby Taylor selected for seating.")}><ChevronDown size={15} /></button>
              </li>
              <li>
                <span>03</span>
                <div><strong>Ben Nguyen</strong><small>NPL-09340 · 4 min</small></div>
                <button type="button" aria-label="Seat Ben Nguyen" onClick={() => onNotice("Ben Nguyen selected for seating.")}><ChevronDown size={15} /></button>
              </li>
            </ol>
            <button className="text-button" type="button" onClick={() => onNotice("Full waitlist opened.")}>View full waitlist <span>→</span></button>
          </section>

          <section className="panel activity-panel">
            <header className="panel-header compact-panel-header">
              <div>
                <p>Audit trail</p>
                <h2>Recent activity</h2>
              </div>
              <Activity size={18} />
            </header>
            <ul className="activity-list">
              <li><span className="activity-icon activity-icon--green"><UserPlus size={14} /></span><div><strong>Zara King seated</strong><small>Table 03 · Seat 6 · 2m ago</small></div></li>
              <li><span className="activity-icon activity-icon--gold"><CircleDollarSign size={14} /></span><div><strong>Rebuy recorded</strong><small>Ethan Wong · $500 · 8m ago</small></div></li>
              <li><span className="activity-icon"><RefreshCw size={14} /></span><div><strong>Cloud sync complete</strong><small>47 records · 11m ago</small></div></li>
            </ul>
          </section>
        </aside>
      </div>
    </>
  )
}

function MetricCard({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: LucideIcon
  label: string
  value: string
  note: string
  tone: "cyan" | "blue" | "gold" | "green"
}) {
  return (
    <article className={`metric-card metric-card--${tone}`}>
      <div className="metric-icon"><Icon size={18} /></div>
      <div>
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{note}</span>
      </div>
    </article>
  )
}

function ModulePreview({
  id,
  onNotice,
}: {
  id: PreviewNavId
  onNotice: (message: string) => void
}) {
  const title = moduleTitles[id]
  const cards = modulePreviewCards[id]
  const Icon = modulePreviewIcons[id]

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{title.eyebrow}</p>
          <h1>{title.title}</h1>
          <p className="page-description">{title.description}</p>
        </div>
        <div className="page-actions">
          <button className="primary-button" type="button" onClick={() => onNotice(`${title.title} action is ready for backend wiring.`)}>
            <Plus size={17} />
            New action
          </button>
        </div>
      </div>

      <section className="module-preview-grid">
        {cards.map(([label, value, note], index) => (
          <article className="module-preview-card" key={label}>
            <span>0{index + 1}</span>
            <p>{label}</p>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>

      <section className="panel module-empty-state">
        <div className="module-empty-icon">
          <Icon size={28} />
        </div>
        <p>Design foundation ready</p>
        <h2>{title.title} workspace</h2>
        <span>This module now has the NPL operational shell and is ready for its API workflow.</span>
      </section>
    </>
  )
}

function formatLeaseDate(value: string | null | undefined) {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(parsed)
}

function OverviewWorkspace({ onNotice }: { onNotice: (message: string) => void }) {
  const title = moduleTitles.overview
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [licenseError, setLicenseError] = useState(false)
  const [checking, setChecking] = useState(false)

  const loadLicense = useCallback(async () => {
    try {
      const response = await fetch("/api/license/status", { headers: { Accept: "application/json" } })
      if (!response.ok) throw new Error("Licence status unavailable")
      setLicense((await response.json()) as LicenseStatus)
      setLicenseError(false)
    } catch {
      setLicenseError(true)
    }
  }, [])

  useEffect(() => {
    void loadLicense()
  }, [loadLicense])

  const recheckLicense = async () => {
    if (checking) return
    setChecking(true)
    try {
      const response = await fetch("/api/license/check", {
        method: "POST",
        headers: { Accept: "application/json" },
      })
      const body = await response.json() as LicenseStatus | { status: LicenseStatus }
      const status = "status" in body ? body.status : body
      setLicense(status)
      setLicenseError(false)
      onNotice(status.valid
        ? "The licence lease was refreshed with the NPL cloud."
        : "The licence could not be refreshed. Check this machine's internet connection.")
    } catch {
      onNotice("The licence server could not be reached. The current lease stays in effect.")
    } finally {
      setChecking(false)
    }
  }

  const lease = license?.lease ?? null
  const valid = license?.valid ?? false

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{title.eyebrow}</p>
          <h1>{title.title}</h1>
          <p className="page-description">{title.description}</p>
        </div>
        <div className="page-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={checking}
            onClick={() => void recheckLicense()}
          >
            <RefreshCw size={16} />
            {checking ? "Checking licence…" : "Re-check licence"}
          </button>
        </div>
      </div>

      <section className="metric-grid" aria-label="Tonight at a glance">
        <MetricCard icon={Table2} label="Tables in play" value="5" note="4 live · 1 seating" tone="cyan" />
        <MetricCard icon={Users} label="Players on floor" value="43" note="Up 8 since 6 PM" tone="blue" />
        <MetricCard icon={ListChecks} label="Open actions" value="6" note="Registrations waiting" tone="gold" />
        <MetricCard icon={LoaderPinwheel} label="Jackpot pool" value="$4,820" note="Backed by desk entries" tone="green" />
      </section>

      <section className="panel license-panel" aria-label="CD-Key licence">
        <header className="panel-header compact-panel-header">
          <div>
            <p>This install</p>
            <h2>CD-Key licence</h2>
          </div>
          {valid ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
        </header>

        {licenseError ? (
          <div className="license-panel__error">
            <AlertTriangle size={22} />
            <p>The local licence state could not be read. Local operations continue while the last lease holds.</p>
          </div>
        ) : (
          <div className="license-panel__body">
            <div className={valid ? "license-keycard" : "license-keycard license-keycard--invalid"}>
              <span className="license-keycard__suit license-keycard__suit--top" aria-hidden="true">♠</span>
              <span className="license-keycard__suit license-keycard__suit--bottom" aria-hidden="true">♠</span>
              <div className="license-keycard__head">
                <span className="license-keycard__icon"><KeyRound size={17} /></span>
                <small>{lease?.product ?? "NPL Poker Internal"}</small>
              </div>
              <strong className="license-keycard__key">{license?.masked_key || "Not activated"}</strong>
              <div className={valid ? "license-keycard__state" : "license-keycard__state license-keycard__state--warn"}>
                <i />
                {valid ? "Licence active" : license?.activated ? "Lease expired" : "Awaiting activation"}
              </div>
              <footer>
                <span>{lease?.venue_name || "No venue bound"}</span>
                <span>{lease?.label || license?.device_id || "—"}</span>
              </footer>
            </div>

            <dl className="license-facts">
              <div>
                <dt>Device ID</dt>
                <dd>{license?.device_id ?? "—"}</dd>
              </div>
              <div>
                <dt>Device label</dt>
                <dd>{lease?.device_label || "This station"}</dd>
              </div>
              <div>
                <dt>Lease held until</dt>
                <dd>{formatLeaseDate(lease?.lease_until)}</dd>
              </div>
              <div>
                <dt>Licence expires</dt>
                <dd>{formatLeaseDate(lease?.expires_at)}</dd>
              </div>
              <div>
                <dt>Licence server</dt>
                <dd>{license?.cloud_base?.replace(/^https?:\/\//, "") ?? "—"}</dd>
              </div>
              <div>
                <dt>Lease status</dt>
                <dd>{lease?.status ? lease.status.replace(/^./, (letter) => letter.toUpperCase()) : "—"}</dd>
              </div>
            </dl>
          </div>
        )}

        <footer className="license-panel__foot">
          <ShieldCheck size={15} />
          <span>
            {license?.message ||
              "The lease re-checks with the NPL cloud every six hours. A revoked key locks this desk at its next check."}
          </span>
        </footer>
      </section>

      <section className="module-preview-grid" aria-label="Floor summary">
        {[
          ["Registrations", "54 checked in", "6 waiting · longest 11 min"],
          ["Cash game floor", "5 tables", "43 players seated"],
          ["Club programme", "1,284 members", "9 club cards queued to print"],
        ].map(([label, value, note], index) => (
          <article className="module-preview-card" key={label}>
            <span>0{index + 1}</span>
            <p>{label}</p>
            <strong>{value}</strong>
            <small>{note}</small>
          </article>
        ))}
      </section>
    </>
  )
}
