import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { QRCodeSVG } from "qrcode.react"
import NplTransitLoader from "./NplTransitLoader"
// Each tab's code, CSS and (for the wheel) fonts only load once you open
// that tab — previously all six shipped in the one bundle every boot.
const HostWorkspace = lazy(() => import("./desk/HostWorkspace"))
const EventsWorkspace = lazy(() => import("./desk/EventsWorkspace"))
const ExportWorkspace = lazy(() => import("./export/ExportWorkspace"))
const JackpotWheelWorkspace = lazy(() => import("./jackpot/JackpotWheelWorkspace"))
const MembershipWorkspace = lazy(() => import("./membership/MembershipWorkspace"))
const PlayersWorkspace = lazy(() => import("./players/PlayersWorkspace"))
const RegistrationsWorkspace = lazy(() => import("./registrations/RegistrationsWorkspace"))
const ChatPane = lazy(() => import("./notifications/ChatPane"))
import { deskApi, type ActiveSession, type CloudQueueStatus, type UpcomingSession, type Venue } from "./desk/deskApi"
import { useBackendLink, type BackendLinkStatus } from "./realtime/backendLink"
import { noticeTime, useNotices, type NoticeCategory } from "./notifications/store"
import { describeRun, syncApi } from "./sync/syncApi"
import nplLogoUrl from "./assets/npl-logo.png"
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  Copy,
  FileSpreadsheet,
  Gauge,
  IdCard,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LoaderPinwheel,
  LogIn,
  LogOut,
  Medal,
  Menu,
  Minus,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
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
  staff_console_login: boolean
  time: string
  // The cloud's minimum-version policy, recomputed by the host against its
  // own build — when update_required is true the console blocks outright.
  update_required?: boolean
  update_message?: string
  minimum_version?: string
  latest_version?: string
  update_download_url?: string
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

type NavId =
  | "overview"
  | "tournament"
  | "cashgame"
  | "events"
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
      { id: "events", label: "Events", icon: Medal },
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
  events: {
    eyebrow: "Venue command",
    title: "Events",
    description: "Host Special Events and Main Event flights — run each in tournament or cash game mode.",
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

// A console sign-in covers one shift, not the life of the machine: past
// this age the stored identity lapses and the next boot demands the gate.
const CONSOLE_SHIFT_HOURS = 12

function readStoredConsoleSession(): StaffIdentity | null {
  try {
    const stored = window.localStorage.getItem("npl.activeStaff")
    if (!stored) return null
    const parsed: unknown = JSON.parse(stored)
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as { staff?: StaffIdentity; signed_in_at?: string }
    if (!record.staff || typeof record.staff.name !== "string" || typeof record.signed_in_at !== "string") return null
    const signedInAt = new Date(record.signed_in_at).getTime()
    if (!Number.isFinite(signedInAt) || Date.now() - signedInAt > CONSOLE_SHIFT_HOURS * 60 * 60 * 1000) return null
    return record.staff
  } catch {
    // Corrupt storage = signed out.
  }
  return null
}

/**
 * The mandatory operator gate: the OS is unusable until one person signs
 * in — with their NPL ADMIN account, the exact same login and password
 * as the website's admin console. Credentials are verified against the
 * cloud; everyone else assists from a phone via the admin session QR.
 */
function ConsoleSignInGate({
  onSignedIn,
}: {
  onSignedIn: (staff: StaffIdentity) => void
}) {
  const [loginField, setLoginField] = useState("")
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch("/api/v1/console/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ login: loginField.trim(), password }),
      })
      const body = await response.json() as {
        ok?: boolean
        data?: { identity?: StaffIdentity }
        error?: { message?: string }
      }
      if (!response.ok || !body.ok || !body.data?.identity) {
        setError(body.error?.message ?? "The sign-in could not be completed. Try again.")
        return
      }
      onSignedIn(body.data.identity)
    } catch {
      setError("The local service could not be reached — it may still be starting. Try again in a moment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="console-gate" role="dialog" aria-modal="true" aria-label="Operator sign-in">
      <div className="console-gate__glow" aria-hidden="true" />
      <div className="console-gate__card">
        <header className="console-gate__brand">
          <img src={nplLogoUrl} alt="" />
          <div>
            <strong>NPL Poker</strong>
            <span>Operational System</span>
          </div>
        </header>

        <h1>Operator sign-in</h1>
        <p>
          Sign in with your NPL admin account — the same login and password as the
          website&rsquo;s admin console.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label className="console-gate__field">
            <span><IdCard size={14} /> Username or email</span>
            <input
              value={loginField}
              onChange={(event) => setLoginField(event.target.value)}
              placeholder="Your admin username"
              spellCheck={false}
              autoComplete="username"
              autoFocus
              maxLength={160}
              disabled={submitting}
              required
            />
          </label>
          <label className="console-gate__field">
            <span><KeyRound size={14} /> Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Your admin password"
              autoComplete="current-password"
              maxLength={128}
              disabled={submitting}
              required
            />
          </label>
          {error ? <p className="console-gate__error" role="alert">{error}</p> : null}
          <button
            type="submit"
            className="console-gate__submit"
            disabled={submitting || loginField.trim() === "" || password === ""}
          >
            {submitting ? "Signing in…" : <><LogIn size={16} /> Sign in</>}
          </button>
        </form>

        <footer className="console-gate__foot">
          <ShieldCheck size={13} aria-hidden="true" />
          One admin runs this console. Admins assisting from a phone sign in there by scanning
          the session QR once a game is open.
        </footer>
      </div>
    </section>
  )
}

/**
 * Harder than the operator gate: when the cloud says this build is below its
 * minimum, every internal endpoint refuses with 426 anyway — so the console
 * blocks outright and tells the operator how to update. Deliberately no
 * dismiss: rendered after ConsoleSignInGate so it covers even that.
 */
function UpdateRequiredGate({ health }: { health: Health }) {
  return (
    <section className="console-gate console-gate--update" role="dialog" aria-modal="true" aria-label="Update required">
      <div className="console-gate__glow" aria-hidden="true" />
      <div className="console-gate__card">
        <header className="console-gate__brand">
          <img src={nplLogoUrl} alt="" />
          <div>
            <strong>NPL Poker</strong>
            <span>Operational System</span>
          </div>
        </header>

        <h1 className="console-gate__warn-title">
          <ShieldAlert size={20} aria-hidden="true" />
          Update required
        </h1>
        <p>{health.update_message || "Please update NPL Poker OS to continue."}</p>

        <dl className="console-gate__versions">
          <div>
            <dt>Installed</dt>
            <dd>{health.version}</dd>
          </div>
          <div>
            <dt>Required</dt>
            <dd>{health.minimum_version || "—"}</dd>
          </div>
          {health.latest_version && health.latest_version !== health.minimum_version ? (
            <div>
              <dt>Latest</dt>
              <dd>{health.latest_version}</dd>
            </div>
          ) : null}
        </dl>

        {health.update_download_url ? (
          <a
            className="console-gate__submit"
            href={health.update_download_url}
            target="_blank"
            rel="noreferrer"
          >
            <RefreshCw size={16} /> Get the update
          </a>
        ) : null}

        <footer className="console-gate__foot">
          <ShieldCheck size={13} aria-hidden="true" />
          Run the latest NPL Poker OS installer on this machine, then reopen the
          console. Your data and CD-Key licence stay in place.
        </footer>
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

/**
 * The admin session QR, shown in the sidebar EXACTLY while the room has an
 * unfinished session (draft/running/paused) — created means scannable,
 * finished means gone. Same payload as the desk's Admin QR dialog: the iOS
 * admin app's only door into a session.
 */
function SidebarAdminQR({ session }: { session: ActiveSession | null }) {
  // Keyed on the primitive QR fields, not the session object itself — the
  // 15s desk poll hands back a fresh object every time even when nothing
  // relevant changed, and QR encoding is real work, not a cheap format.
  const qrValue = useMemo(() => {
    if (!session) return ""
    return JSON.stringify({
      npl: "session",
      uid: session.qr.tournament_uid,
      gs: session.qr.game_session_id,
      name: session.qr.name,
      venue: session.qr.venue_name,
    })
  }, [session?.qr.tournament_uid, session?.qr.game_session_id, session?.qr.name, session?.qr.venue_name])

  if (!session) return null

  const statusLabel = session.status === "running"
    ? "Playing"
    : session.status === "paused"
      ? "Paused"
      : "Hosting"

  return (
    <section className="sidebar-admin-qr" aria-label="Admin session QR code">
      <header>
        <div>
          <span><i /> Admin QR</span>
          <strong>{statusLabel} · {session.game_type === "cash" ? "Cash game" : "Tournament"}</strong>
        </div>
      </header>
      <div className="sidebar-admin-qr__code">
        <QRCodeSVG
          value={qrValue}
          size={164}
          level="M"
          marginSize={1}
          bgColor="#ffffff"
          fgColor="#07142b"
          title="Admin session QR"
        />
      </div>
      <footer>
        <strong>{session.name ?? "This session"}</strong>
        <small>Scan with the NPL admin app</small>
      </footer>
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

  // Unseen tracking for the bell badge and the Chat sub-tab badge. Both
  // start at boot time so the 300 persisted notices never badge a fresh
  // launch — only what arrives while the OS is running counts as unseen.
  // The notice-store subscription lives in BellBadge, NOT here: a busy
  // night fires notify() on every desk signal, and each one re-rendering
  // the whole App (host desk included) is a real cost on venue hardware.
  const [noticesSeenAt, setNoticesSeenAt] = useState<number>(() => Date.now())
  const [chatSeenAt, setChatSeenAt] = useState<number>(() => Date.now())

  // Everything on screen while the panel was open counts as seen the
  // moment it closes.
  useEffect(() => {
    if (!notificationOpen) return
    return () => setNoticesSeenAt(Date.now())
  }, [notificationOpen])

  const markChatSeen = useCallback(() => setChatSeenAt(Date.now()), [])

  // The sidebar admin QR mirrors the desk: it exists exactly while the room
  // has an unfinished session. Poll + the same signals the sessions hub uses,
  // plus the desk's own local create/finish/discard event.
  const [activeDeskSession, setActiveDeskSession] = useState<ActiveSession | null>(null)

  // The desk→cloud call queue: quiet when empty; the statusbar chip shows
  // work on the way and turns red when something needs the operator.
  const [cloudQueue, setCloudQueue] = useState<CloudQueueStatus | null>(null)
  const [queuePanelOpen, setQueuePanelOpen] = useState(false)
  const [queueBusy, setQueueBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = () => {
      deskApi.activeSession()
        .then((session) => { if (!cancelled) setActiveDeskSession(session) })
        .catch(() => { /* backend starting up — keep the last known state */ })
      deskApi.cloudQueueStatus()
        .then((status) => { if (!cancelled) setCloudQueue(status) })
        .catch(() => { /* status is cosmetic — never block the shell */ })
    }
    refresh()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh()
    }, 15000)
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", refreshWhenVisible)
    window.addEventListener("npl:sessions-updated", refresh)
    window.addEventListener("npl:desk-session-changed", refresh)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
      window.removeEventListener("npl:sessions-updated", refresh)
      window.removeEventListener("npl:desk-session-changed", refresh)
    }
  }, [])
  // The signed-in operator — ONLY an admin sign-in verified against the
  // cloud (the same account and password as the website's admin console)
  // can set this, and the gate below blocks the OS until it is set.
  // Persisted with a timestamp so a reload at the desk doesn't sign the
  // operator out mid-shift, but a new day starts locked.
  const [activeStaff, setActiveStaff] = useState<StaffIdentity | null>(readStoredConsoleSession)

  const handleConsoleSignIn = (staff: StaffIdentity) => {
    setActiveStaff(staff)
    window.localStorage.setItem(
      "npl.activeStaff",
      JSON.stringify({ staff, signed_in_at: new Date().toISOString() }),
    )
    setNotice(`${staff.name} signed in at this console.`)
  }

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

  useEffect(() => {
    void loadHealth()
    // Quiet re-poll (no loading flash): the update gate must arm without a
    // reload once the host's boot-time licence check brings the cloud's
    // version policy in — and at the 6-hourly re-checks after that.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return
      void fetch("/api/health", { headers: { Accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((body) => {
          if (body) setHealth({ status: "ready", health: body as Health })
        })
        .catch(() => undefined)
    }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [loadHealth])

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

        <SidebarAdminQR session={activeDeskSession} />

        <div className="operator-card">
          <div className="operator-avatar">{activeStaff ? activeStaff.initials : "—"}</div>
          <div>
            <strong>{activeStaff ? activeStaff.name : "Not signed in"}</strong>
            <span>{activeStaff ? `${activeStaff.role} · ${activeStaff.id}` : "Sign-in required"}</span>
          </div>
          {activeStaff ? (
            <button
              className="operator-action"
              type="button"
              aria-label="Sign out of this console"
              title="Sign out"
              onClick={() => {
                setActiveStaff(null)
                window.localStorage.removeItem("npl.activeStaff")
                setNotice("The staff sign-in was cleared from this console.")
              }}
            >
              <LogOut size={16} />
            </button>
          ) : null}
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
                <BellBadge seenAt={noticesSeenAt} suppressed={notificationOpen} />
              </button>
            </div>
            <DesktopWindowControls hasPendingChanges={false} />
          </div>
        </header>

        <div className={notificationOpen ? "app-content app-content--notification-open" : "app-content"}>
          <main className="workspace">
            {activeSection === "overview" ? (
              <OverviewWorkspace venue={activeVenue} onNavigate={chooseSection} onNotice={setNotice} />
            ) : (
              <Suspense fallback={<div className="workspace-tab-loading">Loading…</div>}>
                {activeSection === "tournament" ? (
                  <HostWorkspace venue={activeVenue} />
                ) : activeSection === "jackpot" ? (
                  <JackpotWheelWorkspace />
                ) : activeSection === "membership" ? (
                  <MembershipWorkspace venue={activeVenue} />
                ) : activeSection === "players" ? (
                  <PlayersWorkspace venue={activeVenue} />
                ) : activeSection === "cashgame" ? (
                  <HostWorkspace venue={activeVenue} mode="cash" />
                ) : activeSection === "events" ? (
                  <EventsWorkspace venue={activeVenue} />
                ) : activeSection === "export" ? (
                  <ExportWorkspace venue={activeVenue} />
                ) : (
                  <RegistrationsWorkspace venue={activeVenue} />
                )}
              </Suspense>
            )}
          </main>

          {notificationOpen ? (
            <NotificationSession
              venue={activeVenue}
              onNavigate={chooseSection}
              chatSeenAt={chatSeenAt}
              onChatSeen={markChatSeen}
            />
          ) : null}
        </div>

        <footer className="statusbar">
          <div>
            <span className={`health-dot health-dot--${health.status}`} />
            <span>Local services {health.status === "ready" ? "operational" : health.status}</span>
          </div>
          <div>
            {cloudQueue !== null && (cloudQueue.pending > 0 || cloudQueue.dead > 0 || (cloudQueue.outbox_dead_count ?? 0) > 0) ? (
              <>
                <button
                  type="button"
                  className={(cloudQueue.dead + (cloudQueue.outbox_dead_count ?? 0)) > 0 ? "cloudq-chip cloudq-chip--dead" : "cloudq-chip"}
                  onClick={() => setQueuePanelOpen(true)}
                  title="Cloud sync queue — desk changes on their way to the NPL cloud"
                >
                  {(cloudQueue.dead + (cloudQueue.outbox_dead_count ?? 0)) > 0
                    ? `Cloud sync: ${cloudQueue.dead + (cloudQueue.outbox_dead_count ?? 0)} failed${cloudQueue.pending > 0 ? ` · ${cloudQueue.pending} on the way` : ""}`
                    : `Cloud sync: ${cloudQueue.pending} on the way`}
                </button>
                <span className="statusbar-divider" />
              </>
            ) : null}
            <span>Last sync <strong>just now</strong></span>
            <span className="statusbar-divider" />
            <span>{health.status === "ready" ? `Build ${health.health.version}` : "Build —"}</span>
          </div>
        </footer>
      </div>

      {queuePanelOpen ? (
        <div className="cloudq-modal" role="presentation" onMouseDown={() => setQueuePanelOpen(false)}>
          <section className="cloudq-modal__panel" role="dialog" aria-modal="true" aria-label="Cloud sync queue" onMouseDown={(e) => e.stopPropagation()}>
            <header className="cloudq-modal__head">
              <h3>Cloud sync queue</h3>
              <button type="button" aria-label="Close" onClick={() => setQueuePanelOpen(false)}><X size={16} /></button>
            </header>

            <p className="cloudq-modal__meta">
              {cloudQueue?.pending ?? 0} on the way · {(cloudQueue?.dead ?? 0) + (cloudQueue?.outbox_dead_count ?? 0)} failed for good.
              Changes apply on this desk instantly and ride this queue to the NPL cloud with automatic retries.
            </p>

            {(cloudQueue?.outbox_dead?.length ?? 0) > 0 ? (
              <>
                <p className="cloudq-modal__meta"><strong>Money outbox</strong> — these carry paid entries or finish reports:</p>
                <ul className="cloudq-modal__list">
                  {cloudQueue?.outbox_dead.map((item) => (
                    <li key={`ob-${item.id}`}>
                      <div className="cloudq-modal__label">
                        <strong>{item.label}</strong>
                        <small>{item.last_error ?? "No error recorded"} · {item.attempts} attempts</small>
                      </div>
                      <div className="cloudq-modal__actions">
                        <button
                          type="button"
                          disabled={queueBusy}
                          onClick={() => {
                            setQueueBusy(true)
                            void deskApi.cloudQueueRetryOutbox(item.id)
                              .then(() => deskApi.cloudQueueStatus())
                              .then(setCloudQueue)
                              .catch(() => undefined)
                              .finally(() => setQueueBusy(false))
                          }}
                        >
                          Retry
                        </button>
                        <button
                          type="button"
                          className="cloudq-modal__discard"
                          disabled={queueBusy}
                          onClick={() => {
                            setQueueBusy(true)
                            void deskApi.cloudQueueDiscardOutbox(item.id)
                              .then(() => deskApi.cloudQueueStatus())
                              .then(setCloudQueue)
                              .catch(() => undefined)
                              .finally(() => setQueueBusy(false))
                          }}
                        >
                          Discard
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {(cloudQueue?.dead_items.length ?? 0) === 0 && (cloudQueue?.outbox_dead?.length ?? 0) === 0 ? (
              <p className="cloudq-modal__empty">Nothing needs attention.</p>
            ) : (
              <ul className="cloudq-modal__list">
                {cloudQueue?.dead_items.map((item) => (
                  <li key={item.id}>
                    <div className="cloudq-modal__label">
                      <strong>{item.label}</strong>
                      <small>{item.last_error ?? "No error recorded"} · {item.attempts} attempts</small>
                    </div>
                    <div className="cloudq-modal__actions">
                      <button
                        type="button"
                        disabled={queueBusy}
                        onClick={() => {
                          setQueueBusy(true)
                          void deskApi.cloudQueueRetry(item.id)
                            .then(() => deskApi.cloudQueueStatus())
                            .then(setCloudQueue)
                            .catch(() => undefined)
                            .finally(() => setQueueBusy(false))
                        }}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        className="cloudq-modal__discard"
                        disabled={queueBusy}
                        onClick={() => {
                          setQueueBusy(true)
                          void deskApi.cloudQueueDiscard(item.id)
                            .then(() => deskApi.cloudQueueStatus())
                            .then(setCloudQueue)
                            .catch(() => undefined)
                            .finally(() => setQueueBusy(false))
                        }}
                      >
                        Discard
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}

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
      {health.status === "ready" && health.health.staff_console_login && !activeStaff ? (
        <ConsoleSignInGate onSignedIn={handleConsoleSignIn} />
      ) : null}
      {health.status === "ready" && health.health.update_required ? (
        <UpdateRequiredGate health={health.health} />
      ) : null}
      {startupPhase !== "hidden" ? <StartupScreen leaving={startupPhase === "leaving"} /> : null}
    </div>
  )
}


const NOTICE_TABS: { id: "all" | NoticeCategory, label: string }[] = [
  { id: "all", label: "All" },
  { id: "registration", label: "Registrations" },
  { id: "system", label: "System" },
]

/**
 * The bell's unseen count. Isolated so IT subscribes to the notice store,
 * not App — every notify() would otherwise re-render the whole shell.
 * Suppressed while the panel is open: the operator is already looking.
 */
function BellBadge({ seenAt, suppressed }: { seenAt: number, suppressed: boolean }) {
  const notices = useNotices()

  if (suppressed) return null

  const unseen = notices.filter((entry) => new Date(entry.at).getTime() > seenAt).length

  if (unseen === 0) return null

  return <span className="notification-button__badge">{unseen > 99 ? "99+" : unseen}</span>
}

function NotificationSession({ venue, chatSeenAt, onChatSeen }: {
  venue: Venue | null
  onNavigate: (id: NavId) => void
  chatSeenAt: number
  onChatSeen: () => void
}) {
  const notices = useNotices()
  const [pane, setPane] = useState<"notifications" | "chat">("notifications")
  const [tab, setTab] = useState<"all" | NoticeCategory>("all")
  const visible = tab === "all" ? notices : notices.filter((notice) => notice.category === tab)

  // While the Chat pane is on screen the operator is reading the feed —
  // its badge stays suppressed at render time (no one-frame flash), and
  // leaving the pane watermarks everything shown as seen.
  useEffect(() => {
    if (pane !== "chat") return
    onChatSeen()
    return () => onChatSeen()
  }, [pane, notices, onChatSeen])

  const unseenChat = pane === "chat"
    ? 0
    : notices.filter(
        (entry) => entry.category === "chat" && new Date(entry.at).getTime() > chatSeenAt,
      ).length

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
        {pane === "chat" ? null : <strong>{visible.length}</strong>}
      </header>

      <div className="notification-session__tabs" role="tablist" aria-label="Notification panes">
        <button
          type="button"
          role="tab"
          aria-selected={pane === "notifications"}
          className={pane === "notifications" ? "notification-tab notification-pane-tab notification-tab--active" : "notification-tab notification-pane-tab"}
          onClick={() => setPane("notifications")}
        >
          Notifications
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={pane === "chat"}
          className={pane === "chat" ? "notification-tab notification-pane-tab notification-tab--active" : "notification-tab notification-pane-tab"}
          onClick={() => setPane("chat")}
        >
          Chat
          {unseenChat > 0 ? (
            <span className="notification-chat-badge">{unseenChat > 99 ? "99+" : unseenChat}</span>
          ) : null}
        </button>
      </div>

      {pane === "chat" ? (
        <Suspense fallback={<p className="chat-pane__empty">Loading chat…</p>}>
          <ChatPane venue={venue} />
        </Suspense>
      ) : (
      <>
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
      </>
      )}

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

      <ReceiptSettingsPanel onNotice={onNotice} />

    </>
  )
}

type ReceiptSettings = {
  enabled: boolean
  printer_name: string | null
  header_text: string | null
  footer_text: string | null
}

/**
 * The venue's receipt printing, on the Overview tab: auto-print stays ON
 * by default — every buy-in, rebuy, add-on and jackpot entry prints
 * silently on the venue's receipt printer, whether the desk or an admin
 * phone handled it. The header and footer are the venue's own words;
 * table and seat always print with them.
 */
function ReceiptSettingsPanel({ onNotice }: { onNotice: (message: string) => void }) {
  const [settings, setSettings] = useState<ReceiptSettings | null>(null)
  const [printers, setPrinters] = useState<string[]>([])
  const [defaultPrinter, setDefaultPrinter] = useState("")
  // What "no printer picked" resolves to: the bridge hunts the installed
  // queues for the venue's POS-80 before trusting the Windows default.
  // auto_mode says how that queue will be driven — "escpos" for a real
  // POS printer, "document" when receipts render as pages (PDF/laser).
  const [autoPrinter, setAutoPrinter] = useState("")
  const [autoMode, setAutoMode] = useState("")
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void fetch("/api/v1/receipts/settings", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((body: { data?: { settings?: ReceiptSettings } }) => {
        if (body.data?.settings) setSettings(body.data.settings)
      })
      .catch(() => undefined)

    void fetch("/api/print/printers", { headers: { Accept: "application/json" } })
      .then((response) => response.json())
      .then((body: { printers?: string[] | null, default_printer?: string, auto_printer?: string, auto_mode?: string }) => {
        setPrinters(body.printers ?? [])
        setDefaultPrinter(body.default_printer ?? "")
        setAutoPrinter(body.auto_printer ?? "")
        setAutoMode(body.auto_mode ?? "")
      })
      .catch(() => undefined)
  }, [])

  const save = async () => {
    if (!settings || saving) return
    setSaving(true)
    try {
      const response = await fetch("/api/v1/receipts/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(settings),
      })
      if (!response.ok) throw new Error("save failed")
      onNotice("Receipt settings saved.")
    } catch {
      onNotice("The receipt settings could not be saved. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const testPrint = async () => {
    if (testing) return
    setTesting(true)
    try {
      const response = await fetch("/api/v1/receipts/test", {
        method: "POST",
        headers: { Accept: "application/json" },
      })
      const body = await response.json() as { data?: { result?: string } }
      onNotice(body.data?.result === "printed"
        ? "Test receipt sent to the printer."
        : "The test receipt did not print — check the printer name and that the printer is on.")
    } catch {
      onNotice("The test receipt did not print — the print bridge could not be reached.")
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="panel receipt-panel" aria-label="Receipt printing">
      <header className="panel-header compact-panel-header">
        <div>
          <p>Front desk</p>
          <h2>Receipt printing</h2>
        </div>
        <Printer size={18} />
      </header>

      {settings === null ? (
        <p className="express-sessions__empty">Loading receipt settings…</p>
      ) : (
        <div className="receipt-panel__body">
          <label className="receipt-panel__toggle">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            <span>
              <strong>Print receipts automatically</strong>
              <small>
                Every buy-in, rebuy, add-on and jackpot entry prints silently — desk scans and
                admin-phone sales alike. No dialogs, ever.
              </small>
            </span>
          </label>

          <label className="receipt-panel__field">
            <span>Receipt printer</span>
            <select
              value={settings.printer_name ?? ""}
              onChange={(event) => setSettings({ ...settings, printer_name: event.target.value || null })}
            >
              <option value="">
                {autoPrinter
                  ? autoMode === "document"
                    ? `Auto — ${autoPrinter} (no POS printer — receipts print as pages)`
                    : `Auto — ${autoPrinter} (POS printer found)`
                  : defaultPrinter
                    ? `Windows default — ${defaultPrinter}`
                    : "Windows default printer"}
              </option>
              {printers.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>

          <label className="receipt-panel__field">
            <span>Header — the venue&rsquo;s own words, printed on top</span>
            <textarea
              rows={2}
              placeholder={"NPL POKER SYDNEY\nOfficial receipt"}
              value={settings.header_text ?? ""}
              onChange={(event) => setSettings({ ...settings, header_text: event.target.value || null })}
            />
          </label>

          <label className="receipt-panel__field">
            <span>Footer — printed underneath</span>
            <textarea
              rows={2}
              placeholder="Thank you & good luck!"
              value={settings.footer_text ?? ""}
              onChange={(event) => setSettings({ ...settings, footer_text: event.target.value || null })}
            />
          </label>

          <div className="receipt-panel__actions">
            <button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save receipt settings"}
            </button>
            <button className="secondary-button" type="button" disabled={testing} onClick={() => void testPrint()}>
              <Printer size={15} /> {testing ? "Printing…" : "Print a test receipt"}
            </button>
          </div>

          <p className="receipt-panel__hint">
            The player&rsquo;s table and seat always print. Sales handled on an admin phone also land in
            the notification feed, so the desk sees them the moment the receipt cuts.
          </p>
        </div>
      )}
    </section>
  )
}

function formatSessionDate(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value

  return parsed.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}
