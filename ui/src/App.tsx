import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { QRCodeSVG } from "qrcode.react"
import NplTransitLoader from "./NplTransitLoader"
import HostWorkspace from "./desk/HostWorkspace"
import ExportWorkspace from "./export/ExportWorkspace"
import JackpotWheelWorkspace from "./jackpot/JackpotWheelWorkspace"
import MembershipWorkspace from "./membership/MembershipWorkspace"
import PlayersWorkspace from "./players/PlayersWorkspace"
import RegistrationsWorkspace from "./registrations/RegistrationsWorkspace"
import { deskApi, type UpcomingSession, type Venue } from "./desk/deskApi"
import { useBackendLink, type BackendLinkStatus } from "./realtime/backendLink"
import { noticeTime, useNotices, type NoticeCategory } from "./notifications/store"
import { describeRun, syncApi } from "./sync/syncApi"
import nplLogoUrl from "./assets/npl-logo.png"
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  FileSpreadsheet,
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
    nplOpenRoomClock?: (target: string) => Promise<void>
    nplClockLayout?: (mode: "mini" | "max") => Promise<void>
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
  | "export"



const navigation: Array<{
  label: string
  items: Array<{ id: NavId; label: string; icon: LucideIcon; badge?: number }>
}> = [
  {
    label: "Operations",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "tournament", label: "Tournament", icon: Trophy },
      { id: "cashgame", label: "Cash Game", icon: CircleDollarSign },
      { id: "registrations", label: "Registrations", icon: ListChecks },
      { id: "players", label: "Players", icon: Users },
      { id: "jackpot", label: "Jackpot Wheel", icon: LoaderPinwheel },
    ],
  },
  {
    label: "Club",
    items: [{ id: "membership", label: "Club Membership ID", icon: IdCard }],
  },
  {
    label: "Reports",
    items: [{ id: "export", label: "Export", icon: FileSpreadsheet }],
  },
]

// Old pinned shortcuts (?tab=host / ?tab=tables) keep opening the same desks
// under their new names.
const legacyTabIds: Record<string, NavId> = {
  host: "tournament",
  tables: "cashgame",
}


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
  export: {
    eyebrow: "Reports",
    title: "Export",
    description: "Every finished game summarised from the NPL cloud's records, with attendance and CSV downloads.",
  },
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
  refreshing,
  onRefresh,
}: {
  state: NetworkQualityState
  refreshing: boolean
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

  // Compact on purpose: a glance says enough, nobody opens the details.
  // Tapping it re-runs the probe — the old dropdown's only useful control.
  return (
    <button
      className={`connection-signal connection-signal--compact connection-signal--${tone}`}
      type="button"
      disabled={refreshing}
      aria-label={`${grade} internet connection, ${bars} of 5 signal bars${online ? `, level ${level} of 10` : ""}. Tap to re-check.`}
      title="Tap to re-check the internet signal"
      onClick={onRefresh}
    >
      <span className="signal-bars" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <i className={index < bars ? "signal-bar signal-bar--active" : "signal-bar"} key={index} />
        ))}
      </span>
      <span className="connection-signal__copy">
        <small>Internet</small>
        <strong>{grade}</strong>
      </span>
    </button>
  )
}

function BackendLinkLight({
  status,
  enabled,
  hint,
  onToggle,
}: {
  status: BackendLinkStatus
  enabled: boolean
  hint: string | null
  onToggle: () => void
}) {
  const effective = enabled ? status : "off"
  const label = !enabled
    ? "Disconnected"
    : status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting…"
        : "Offline"

  // The tooltip carries the actual reason — a red light nobody can
  // diagnose from the floor is not a status indicator, it is a mystery.
  const title = !enabled
    ? "Tap to connect the live link"
    : status === "connected"
      ? "Live link to the NPL cloud — tap to disconnect"
      : hint ?? "Live link to the NPL cloud — tap to disconnect"

  return (
    <button
      className={`backend-link backend-link--${effective}`}
      type="button"
      aria-label={`Backend live link: ${label}. ${hint ?? ""} Tap to ${enabled ? "disconnect" : "connect"}.`}
      title={title}
      onClick={onToggle}
    >
      <span className="backend-link__light" aria-hidden="true" />
      <span className="backend-link__copy">
        <small>Backend link</small>
        <strong>{label}</strong>
      </span>
    </button>
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
          <span><X size={18} strokeWidth={2.2} /></span>
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
  const [health, setHealth] = useState<HealthState>({ status: "loading" })
  const [networkQuality, setNetworkQuality] = useState<NetworkQualityState>({ status: "loading" })
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

  // Live two-way link to the NPL cloud: auto-connects once the venue is
  // known, signals pull fresh session data within seconds.
  const backendLink = useBackendLink(venueId)

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
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut)
    return () => window.removeEventListener("keydown", handleGlobalShortcut)
  }, [])


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
          refreshing={networkRefreshing}
          onRefresh={() => void loadNetworkQuality(true)}
        />

        <BackendLinkLight
          status={backendLink.status}
          enabled={backendLink.enabled}
          hint={backendLink.lastError}
          onToggle={backendLink.toggle}
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
            <DesktopWindowControls hasPendingChanges={false} />
          </div>
        </header>

        <div className={notificationOpen ? "app-content app-content--notification-open" : "app-content"}>
          <main className="workspace">
            {activeSection === "tournament" ? (
              <HostWorkspace venue={activeVenue} />
            ) : activeSection === "jackpot" ? (
              <JackpotWheelWorkspace />
            ) : activeSection === "membership" ? (
              <MembershipWorkspace venue={activeVenue} />
            ) : activeSection === "players" ? (
              <PlayersWorkspace venue={activeVenue} />
            ) : activeSection === "overview" ? (
              <OverviewWorkspace venue={activeVenue} onNavigate={chooseSection} onNotice={setNotice} />
            ) : activeSection === "cashgame" ? (
              <HostWorkspace venue={activeVenue} mode="cash" />
            ) : activeSection === "export" ? (
              <ExportWorkspace venue={activeVenue} />
            ) : (
              <RegistrationsWorkspace venue={activeVenue} />
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


const NOTICE_TABS: { id: "all" | NoticeCategory, label: string }[] = [
  { id: "all", label: "All" },
  { id: "registration", label: "Registrations" },
  { id: "system", label: "System" },
]

function NotificationSession(_props: { onNavigate: (id: NavId) => void }) {
  const notices = useNotices()
  const [tab, setTab] = useState<"all" | NoticeCategory>("all")
  const visible = tab === "all" ? notices : notices.filter((notice) => notice.category === tab)

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
        <strong>{visible.length}</strong>
      </header>

      <div className="notification-session__tabs" role="tablist" aria-label="Notice categories">
        {NOTICE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? "notification-tab notification-tab--active" : "notification-tab"}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="notification-stream">
        {visible.length === 0 ? (
          <p className="notification-empty">
            {tab === "registration"
              ? "No registrations recorded yet — desk buy-ins and online bookings will appear here."
              : "Nothing recorded yet."}
          </p>
        ) : (
          visible.map((notice) => (
            <div
              className={`notification-item notification-item--${notice.tone === "success" ? "success" : notice.tone === "warning" ? "warning" : notice.category === "registration" ? "registration" : "gold"}`}
              key={notice.id}
            >
              <span>{notice.category === "registration" ? <Users size={19} /> : <Activity size={19} />}</span>
              <div>
                <strong>{notice.title}</strong>
                <small>{notice.detail}</small>
                <time>{noticeTime(notice)}</time>
              </div>
            </div>
          ))
        )}
      </div>

      <footer>
        <ShieldCheck size={16} />
        <span>Notifications remain visible until you press the bell again.</span>
      </footer>
    </aside>
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

function OverviewWorkspace({ venue, onNavigate, onNotice }: {
  venue: Venue | null
  onNavigate: (id: NavId) => void
  onNotice: (message: string) => void
}) {
  const title = moduleTitles.overview
  const [license, setLicense] = useState<LicenseStatus | null>(null)
  const [licenseError, setLicenseError] = useState(false)
  const [checking, setChecking] = useState(false)
  const [upcoming, setUpcoming] = useState<UpcomingSession[]>([])
  const [upcomingLoading, setUpcomingLoading] = useState(false)

  // The express way in: once a venue is picked, its scheduled sessions are
  // one tap from the right workspace.
  useEffect(() => {
    if (venue === null) {
      setUpcoming([])
      return
    }

    let cancelled = false
    const load = (initial: boolean) => {
      if (initial) setUpcomingLoading(true)
      void deskApi.upcomingSessions(venue.id)
        .then((result) => {
          if (!cancelled) setUpcoming(result.sessions)
        })
        .catch(() => {
          if (!cancelled && initial) setUpcoming([])
        })
        .finally(() => {
          if (!cancelled && initial) setUpcomingLoading(false)
        })
    }

    load(true)

    // The live backend link fires this after every pulled change.
    const onSessionsUpdated = () => load(false)
    window.addEventListener("npl:sessions-updated", onSessionsUpdated)

    return () => {
      cancelled = true
      window.removeEventListener("npl:sessions-updated", onSessionsUpdated)
    }
  }, [venue])

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

      <section className="panel express-sessions" aria-label="Upcoming sessions">
        <header className="panel-header compact-panel-header">
          <div>
            <p>{venue ? venue.name : "Pick a venue"}</p>
            <h2>Upcoming sessions</h2>
          </div>
          <CalendarDays size={18} />
        </header>

        {venue === null ? (
          <p className="express-sessions__empty">Pick a venue from the header to see its scheduled sessions.</p>
        ) : upcomingLoading ? (
          <p className="express-sessions__empty">Loading sessions…</p>
        ) : upcoming.length === 0 ? (
          <p className="express-sessions__empty">
            No scheduled sessions in the sync window. Run a manual update if tonight's game is missing.
          </p>
        ) : (
          <ul className="express-sessions__list">
            {upcoming.map((session) => {
              const isCash = session.category === "cash_game"
              return (
                <li key={session.session_id}>
                  <button
                    type="button"
                    className="express-sessions__row"
                    onClick={() => onNavigate(isCash ? "cashgame" : "tournament")}
                  >
                    <span className="express-sessions__date">
                      <strong>{formatSessionDate(session.session_date)}</strong>
                      <small>{session.start_time ? session.start_time.slice(0, 5) : "—"}</small>
                    </span>
                    <span className="express-sessions__title">
                      <strong>{session.title ?? session.venue_name ?? `Session #${session.session_id}`}</strong>
                      <small>
                        {session.registrations_count} registered
                        {session.max_players ? ` · ${session.max_players} max` : ""}
                      </small>
                    </span>
                    <span className={isCash ? "express-sessions__tag express-sessions__tag--cash" : "express-sessions__tag"}>
                      {isCash ? "Cash Game" : session.source_type === "championship" ? "Championship" : "Tournament"}
                    </span>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
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

    </>
  )
}

function formatSessionDate(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value

  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}
