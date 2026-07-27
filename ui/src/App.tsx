import { useCallback, useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import NplTransitLoader from "./NplTransitLoader"
import nplLogoUrl from "./assets/npl-logo.png"
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Copy,
  Gauge,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Medal,
  Menu,
  Minus,
  MonitorCog,
  MoreHorizontal,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Spade,
  Square,
  Table2,
  Trophy,
  Undo2,
  UserPlus,
  Users,
  Wifi,
  X,
  type LucideIcon,
} from "lucide-react"

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

type NavId =
  | "overview"
  | "tables"
  | "registrations"
  | "players"
  | "results"
  | "leaderboard"
  | "system"

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
      { id: "tables", label: "Live Tables", icon: Table2, badge: 5 },
      { id: "registrations", label: "Registrations", icon: ListChecks, badge: 6 },
      { id: "players", label: "Players", icon: Users },
    ],
  },
  {
    label: "Competition",
    items: [
      { id: "results", label: "Results", icon: Medal },
      { id: "leaderboard", label: "Leaderboard", icon: Trophy },
    ],
  },
  {
    label: "Platform",
    items: [{ id: "system", label: "System", icon: MonitorCog }],
  },
]

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
    description: "One view of tonight's floor, registrations, and operational health.",
  },
  tables: {
    eyebrow: "Operational system",
    title: "Live tables",
    description: "Monitor active games, update stacks, and keep every table moving.",
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
  results: {
    eyebrow: "Results archive",
    title: "Results",
    description: "Review completed tables and prepare verified result exports.",
  },
  leaderboard: {
    eyebrow: "Live standings",
    title: "Leaderboard",
    description: "Track venue performance and championship points.",
  },
  system: {
    eyebrow: "Local platform",
    title: "System",
    description: "Inspect the Go host, Caddy gateway, and local service health.",
  },
}

const modulePreviewCards: Record<Exclude<NavId, "tables">, Array<[string, string, string]>> = {
  overview: [
    ["Tables in play", "5", "4 live · 1 seating"],
    ["Players on floor", "43", "Up 8 since 6 PM"],
    ["Open actions", "6", "Registrations waiting"],
  ],
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
  results: [
    ["Completed today", "8", "All balanced"],
    ["Awaiting export", "2", "Ready for review"],
    ["Last close", "6:42 PM", "Table 08"],
  ],
  leaderboard: [
    ["Current leader", "A. Park", "1,860 venue points"],
    ["Players ranked", "96", "Current season"],
    ["Next update", "Tonight", "After session close"],
  ],
  system: [
    ["Go host", "Online", "127.0.0.1:8788"],
    ["Caddy gateway", "Online", "127.0.0.1:8787"],
    ["Resource profile", "Adaptive", "Low-resource runtime limits"],
  ],
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
        <div className="startup-screen__identity">
          <p>National Poker League</p>
          <h1>Operational System</h1>
          <span className="startup-screen__description">Preparing your secure local operations workspace</span>
        </div>

        <div className="startup-screen__checks">
          <span><ShieldCheck size={17} /> Local operations engine</span>
          <span><Network size={17} /> Secure venue gateway</span>
          <span><Wifi size={17} /> OS workspace</span>
        </div>
      </div>
      <footer>
        <span>Private local system</span>
        <i />
        <span>No browser required</span>
      </footer>
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

export default function App() {
  const [activeSection, setActiveSection] = useState<NavId>("tables")
  const [selectedTableId, setSelectedTableId] = useState(tables[0].id)
  const [health, setHealth] = useState<HealthState>({ status: "loading" })
  const [networkQuality, setNetworkQuality] = useState<NetworkQualityState>({ status: "loading" })
  const [connectionPanelOpen, setConnectionPanelOpen] = useState(false)
  const [networkRefreshing, setNetworkRefreshing] = useState(false)
  const [manualUpdating, setManualUpdating] = useState(false)
  const [avatarSyncing, setAvatarSyncing] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [paused, setPaused] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [startupPhase, setStartupPhase] = useState<"visible" | "leaving" | "hidden">("visible")
  const [notificationOpen, setNotificationOpen] = useState(false)
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

  useEffect(() => {
    void loadHealth()
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

  const syncAvatars = () => {
    if (avatarSyncing) return
    setAvatarSyncing(true)
    window.setTimeout(() => {
      setAvatarSyncing(false)
      setNotice("Player avatars were manually refreshed.")
    }, 900)
  }

  const runManualUpdate = async () => {
    if (manualUpdating) return
    setManualUpdating(true)
    await Promise.all([loadHealth(), loadNetworkQuality(true)])
    setManualUpdating(false)
    setNotice("Operations data and connection quality were manually updated.")
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

        <div className="operator-card">
          <div className="operator-avatar">KC</div>
          <div>
            <strong>Kyle Chen</strong>
            <span>Floor manager</span>
          </div>
          <button className="operator-action" type="button" aria-label="Sign out">
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
            <button className="venue-selector" type="button">
              <span className="venue-icon"><Spade size={15} /></span>
              <span>
                <small>Active venue</small>
                The Star Sydney
              </span>
              <ChevronDown size={16} />
            </button>
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
              onClick={syncAvatars}
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
            {activeSection === "tables" ? (
              <LiveTablesWorkspace
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
              <ModulePreview
                id={activeSection}
                health={health}
                onRefresh={loadHealth}
                onNotice={setNotice}
              />
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
    section: "tables",
    icon: Pause,
    tone: "warning",
  },
  {
    id: "rebuy-ethan",
    title: "Rebuy recorded",
    detail: "Ethan Wong · Table 03 · $500",
    time: "8 min",
    section: "tables",
    icon: CircleDollarSign,
    tone: "gold",
  },
  {
    id: "results-ready",
    title: "Two results ready for review",
    detail: "Completed tables are balanced",
    time: "12 min",
    section: "results",
    icon: Trophy,
    tone: "info",
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
    id: "services-healthy",
    title: "Local services healthy",
    detail: "Go host and Caddy are operational",
    time: "22 min",
    section: "system",
    icon: ShieldCheck,
    tone: "success",
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

type LiveTablesWorkspaceProps = {
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

function LiveTablesWorkspace({
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
}: LiveTablesWorkspaceProps) {
  const title = moduleTitles.tables

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
  health,
  onRefresh,
  onNotice,
}: {
  id: Exclude<NavId, "tables">
  health: HealthState
  onRefresh: () => void
  onNotice: (message: string) => void
}) {
  const title = moduleTitles[id]
  const cards = modulePreviewCards[id]

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{title.eyebrow}</p>
          <h1>{title.title}</h1>
          <p className="page-description">{title.description}</p>
        </div>
        <div className="page-actions">
          {id === "system" ? (
            <button className="secondary-button" type="button" onClick={onRefresh}>
              <RefreshCw size={16} />
              Check services
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={() => onNotice(`${title.title} action is ready for backend wiring.`)}>
            <Plus size={17} />
            New action
          </button>
        </div>
      </div>

      <section className="module-preview-grid">
        {cards.map(([label, value, note], index) => {
          let displayValue = value
          let displayNote = note
          if (id === "system" && index < 2) {
            displayValue = health.status === "ready" ? "Online" : health.status
          } else if (id === "system" && index === 2 && health.status === "ready") {
            displayValue = health.health.resource_profile.replace(/^./, (letter) => letter.toUpperCase())
            displayNote = `${health.health.go_max_procs} Go workers · ${health.health.go_memory_limit_mib} MiB limit`
          }

          return (
            <article className="module-preview-card" key={label}>
              <span>0{index + 1}</span>
              <p>{label}</p>
              <strong>{displayValue}</strong>
              <small>{displayNote}</small>
            </article>
          )
        })}
      </section>

      <section className="panel module-empty-state">
        <div className="module-empty-icon">
          {id === "system" ? <Network size={28} /> : <Spade size={28} />}
        </div>
        <p>Design foundation ready</p>
        <h2>{title.title} workspace</h2>
        <span>This module now has the NPL operational shell and is ready for its API workflow.</span>
        {id === "system" ? (
          <div className="system-health-row">
            <span><Wifi size={15} /> Gateway</span>
            <strong>{health.status}</strong>
          </div>
        ) : null}
      </section>
    </>
  )
}
