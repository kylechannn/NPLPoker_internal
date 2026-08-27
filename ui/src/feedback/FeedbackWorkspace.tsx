import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import {
  Bug,
  ChevronDown,
  ChevronRight,
  CloudOff,
  Inbox,
  LifeBuoy,
  Lightbulb,
  Loader2,
  MessageCircle,
  MessageSquareWarning,
  RefreshCw,
  Reply,
  Send,
  type LucideIcon,
} from "lucide-react"
import type { Venue } from "../desk/deskApi"
import {
  categoryLabels,
  feedbackApi,
  reportStamp,
  severityLabels,
  statusLabels,
  type FeedbackCategory,
  type FeedbackFeed,
  type FeedbackSeverity,
} from "./feedbackApi"
import "./feedback.css"

// Structural slices of the shell's own types. App.tsx passes its full
// Health / NetworkQuality / StaffIdentity objects; declaring only the
// fields this tab reads keeps the lazy chunk free of an import back into
// App.tsx.
type StaffIdentity = {
  id: string
  name: string
  role: string
}

type Health = {
  version: string
  resource_profile: string
}

type NetworkQuality = {
  online: boolean
  grade: string
  latency_ms: number
  jitter_ms: number
  reliability_percent: number
  checked_at: string
}

type Props = {
  venue: Venue | null
  staff: StaffIdentity | null
  health: Health | null
  network: NetworkQuality | null
}

type Notice = { tone: "success" | "error", text: string }

const SUBJECT_MAX = 180
const MESSAGE_MAX = 5000

const categories: Array<{ id: FeedbackCategory, icon: LucideIcon, hint: string }> = [
  { id: "bug", icon: Bug, hint: "Something broke or behaved wrongly." },
  { id: "feedback", icon: MessageCircle, hint: "How the software feels to run — what works, what grates." },
  { id: "feature", icon: Lightbulb, hint: "Something that would make the desk easier." },
  { id: "other", icon: LifeBuoy, hint: "Anything else head office should hear." },
]

const severities: FeedbackSeverity[] = ["low", "normal", "high", "critical"]

/**
 * Feedback & Reports — the venue's line to NPL head office. A report is
 * queued locally and rides the cloud call queue, so it can be written
 * mid-outage and still lands; the right-hand list reads back what this
 * licence has sent, its status, and the admin's reply.
 */
export default function FeedbackWorkspace({ venue, staff, health, network }: Props) {
  const [category, setCategory] = useState<FeedbackCategory>("bug")
  const [severity, setSeverity] = useState<FeedbackSeverity>("normal")
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [authorName, setAuthorName] = useState(staff?.name ?? "")
  const [authorEdited, setAuthorEdited] = useState(false)
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const [feed, setFeed] = useState<FeedbackFeed | null>(null)
  const [feedLoading, setFeedLoading] = useState(false)
  const [feedError, setFeedError] = useState<string | null>(null)
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
  const feedSeq = useRef(0)
  const mounted = useRef(true)

  // The operator's name follows the sign-in until they type their own.
  useEffect(() => {
    if (!authorEdited) setAuthorName(staff?.name ?? "")
  }, [staff?.name, authorEdited])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadFeed = useCallback(async () => {
    const seq = ++feedSeq.current
    setFeedLoading(true)
    setFeedError(null)
    try {
      const result = await feedbackApi.feed()
      if (mounted.current && feedSeq.current === seq) setFeed(result)
    } catch (e) {
      if (mounted.current && feedSeq.current === seq) {
        setFeedError(e instanceof Error ? e.message : "Your reports could not be loaded.")
      }
    } finally {
      if (mounted.current && feedSeq.current === seq) setFeedLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadFeed()
  }, [loadFeed])

  // Exactly what "Include this install's diagnostics" attaches — the same
  // object is rendered in the preview and sent with the report, so the
  // operator never has to take it on trust.
  const diagnostics = useMemo(
    () => ({
      os_version: health?.version ?? null,
      resource_profile: health?.resource_profile ?? null,
      network: network
        ? {
            online: network.online,
            grade: network.grade,
            latency_ms: network.latency_ms,
            jitter_ms: network.jitter_ms,
            reliability_percent: network.reliability_percent,
            checked_at: network.checked_at,
          }
        : null,
      venue: venue ? { id: venue.id, name: venue.name } : null,
      operator: staff ? { name: staff.name, role: staff.role } : null,
      screen: `${window.innerWidth}×${window.innerHeight} (display ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}x)`,
      user_agent: navigator.userAgent,
    }),
    [health, network, venue, staff],
  )

  const diagnosticRows = useMemo<Array<[string, string]>>(() => {
    const rows: Array<[string, string]> = [
      ["OS version", diagnostics.os_version ?? "unknown"],
      ["Resource profile", diagnostics.resource_profile ?? "unknown"],
      [
        "Network",
        diagnostics.network
          ? `${diagnostics.network.online ? diagnostics.network.grade : "Offline"} · ${diagnostics.network.latency_ms} ms · ${diagnostics.network.reliability_percent}% reliable`
          : "not measured yet",
      ],
      ["Venue", diagnostics.venue ? `#${diagnostics.venue.id} ${diagnostics.venue.name ?? ""}`.trim() : "none selected"],
      ["Operator", diagnostics.operator ? `${diagnostics.operator.name} (${diagnostics.operator.role})` : "not signed in"],
      ["Screen", diagnostics.screen],
      ["Browser", diagnostics.user_agent],
      ["Timestamp", "added when you press Send"],
    ]
    return rows
  }, [diagnostics])

  const cloudDown = (network ? !network.online : false) || (feed ? !feed.available : false)
  const canSend = !busy && subject.trim() !== "" && message.trim() !== ""

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canSend) return

    setBusy(true)
    setNotice(null)
    try {
      await feedbackApi.submit({
        category,
        severity: category === "bug" ? severity : null,
        subject: subject.trim(),
        message: message.trim(),
        author_name: authorName.trim() || null,
        venue_id: venue?.id ?? null,
        context: includeDiagnostics ? { ...diagnostics, timestamp: new Date().toISOString() } : null,
      })

      setNotice({
        tone: "success",
        text: cloudDown
          ? "Queued — it sends the moment the cloud link is green."
          : "Sent to NPL head office.",
      })
      setSubject("")
      setMessage("")
      setSeverity("normal")
      setDiagnosticsOpen(false)

      // Now: the queued row appears. A few seconds on: the drains sweeper
      // has usually landed it, so the same row shows as a cloud report.
      void loadFeed()
      window.setTimeout(() => {
        if (mounted.current) void loadFeed()
      }, 6000)
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The report could not be queued." })
    } finally {
      setBusy(false)
    }
  }

  function toggleOpen(key: string) {
    setOpenKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const activeCategory = categories.find((entry) => entry.id === category) ?? categories[0]
  const hasRows = feed !== null && (feed.pending.length > 0 || feed.reports.length > 0)

  return (
    <div className="feedback">
      <section className="feedback__panel feedback__compose" aria-label="Send a report">
        <header className="feedback__panelhead">
          <div>
            <h3><MessageSquareWarning size={18} /> Send a report</h3>
            <p>
              Bugs, feedback and feature requests go straight to NPL head office and are read in the admin
              console. Written offline? It queues here and sends when the link returns.
            </p>
          </div>
        </header>

        <form className="feedback__form" onSubmit={(event) => void submit(event)}>
          <div className="feedback__field">
            <span className="feedback__label">What is this about?</span>
            <div className="feedback__segments" role="radiogroup" aria-label="Report category">
              {categories.map((entry) => {
                const Icon = entry.icon
                const active = entry.id === category
                return (
                  <button
                    type="button"
                    key={entry.id}
                    role="radio"
                    aria-checked={active}
                    className={active ? `feedback__segment feedback__segment--${entry.id} is-active` : "feedback__segment"}
                    onClick={() => setCategory(entry.id)}
                  >
                    <Icon size={15} /> {categoryLabels[entry.id]}
                  </button>
                )
              })}
            </div>
            <small className="feedback__hint">{activeCategory.hint}</small>
          </div>

          {category === "bug" ? (
            <label className="feedback__field feedback__field--severity">
              <span className="feedback__label">Severity</span>
              <select value={severity} onChange={(event) => setSeverity(event.target.value as FeedbackSeverity)}>
                {severities.map((level) => (
                  <option key={level} value={level}>{severityLabels[level]}</option>
                ))}
              </select>
              <small className="feedback__hint">
                {severity === "critical"
                  ? "The desk cannot run a game until this is fixed."
                  : severity === "high"
                    ? "Blocking part of tonight's work — there is a workaround."
                    : severity === "low"
                      ? "Cosmetic or rare — no rush."
                      : "Worth fixing, nothing is on fire."}
              </small>
            </label>
          ) : null}

          <label className="feedback__field">
            <span className="feedback__label">
              Subject
              <em className={subject.length >= SUBJECT_MAX ? "is-full" : undefined}>{subject.length}/{SUBJECT_MAX}</em>
            </span>
            <input
              value={subject}
              maxLength={SUBJECT_MAX}
              placeholder="One line — e.g. Clock froze after the break at level 4"
              onChange={(event) => setSubject(event.target.value)}
            />
          </label>

          <label className="feedback__field">
            <span className="feedback__label">
              Details
              <em className={message.length >= MESSAGE_MAX ? "is-full" : undefined}>{message.length}/{MESSAGE_MAX}</em>
            </span>
            <textarea
              value={message}
              maxLength={MESSAGE_MAX}
              rows={7}
              placeholder={
                category === "bug"
                  ? "What happened? What did you expect instead? Steps to make it happen again, and roughly when."
                  : category === "feature"
                    ? "What would you like the desk to do, and what would it save you on the night?"
                    : "Tell head office what you noticed — the more specific, the more useful."
              }
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>

          <label className="feedback__field">
            <span className="feedback__label">Your name</span>
            <input
              value={authorName}
              maxLength={120}
              placeholder="Who should head office reply to?"
              onChange={(event) => {
                setAuthorEdited(true)
                setAuthorName(event.target.value)
              }}
            />
          </label>

          <div className="feedback__diagnostics">
            <label className="feedback__check">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(event) => setIncludeDiagnostics(event.target.checked)}
              />
              <span>Include this install's diagnostics</span>
            </label>
            <button
              type="button"
              className="feedback__disclose"
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen((open) => !open)}
            >
              {diagnosticsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {diagnosticsOpen ? "Hide what gets attached" : "See what gets attached"}
            </button>
            {diagnosticsOpen ? (
              <dl className={includeDiagnostics ? "feedback__diaglist" : "feedback__diaglist is-off"}>
                {diagnosticRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </div>

          {notice ? (
            <p className={`feedback__notice feedback__notice--${notice.tone}`} role="status">{notice.text}</p>
          ) : null}

          <div className="feedback__actions">
            <button type="submit" className="feedback__send" disabled={!canSend}>
              {busy ? <Loader2 size={15} className="feedback__spin" /> : <Send size={15} />}
              {busy ? "Sending…" : "Send to NPL"}
            </button>
            {venue ? <span className="feedback__scope">Filed for {venue.name ?? `venue #${venue.id}`}</span> : null}
          </div>
        </form>
      </section>

      <section className="feedback__panel feedback__reports" aria-label="Your reports">
        <header className="feedback__panelhead">
          <div>
            <h3><Inbox size={18} /> Your reports</h3>
            <p>Everything this desk has sent, with head office's status and reply.</p>
          </div>
          <button type="button" className="feedback__refresh" disabled={feedLoading} onClick={() => void loadFeed()}>
            {feedLoading ? <Loader2 size={14} className="feedback__spin" /> : <RefreshCw size={14} />} Refresh
          </button>
        </header>

        {feed && !feed.available ? (
          <p className="feedback__offline"><CloudOff size={15} /> Cloud link unavailable — showing what's queued on this desk.</p>
        ) : null}

        {feedError ? (
          <p className="feedback__offline"><CloudOff size={15} /> {feedError}</p>
        ) : null}

        <div className="feedback__listwrap">
          {feed === null && !feedError ? (
            <p className="feedback__empty"><Loader2 size={15} className="feedback__spin" /> Loading your reports…</p>
          ) : feed !== null && !hasRows ? (
            <p className="feedback__empty">Nothing sent from this desk yet — your first report will show here with its status.</p>
          ) : feed !== null ? (
            <ul className="feedback__list">
              {feed.pending.map((row, index) => {
                const key = `pending:${row.client_reference ?? `${row.created_at}:${index}`}`
                return (
                  <li key={key} className="feedback__item feedback__item--pending">
                    <div className="feedback__itemhead">
                      <span className={`feedback__chip feedback__chip--${row.category}`}>{categoryLabels[row.category] ?? row.category}</span>
                      <span className="feedback__status feedback__status--queued">Queued</span>
                      <time>{reportStamp(row.created_at)}</time>
                    </div>
                    <strong className="feedback__subject">{row.subject || "(no subject)"}</strong>
                    <small className="feedback__hint">On its way — it lands as soon as the cloud link is green.</small>
                  </li>
                )
              })}

              {feed.reports.map((report) => {
                const key = `report:${report.id}`
                const open = openKeys.has(key)
                return (
                  <li key={key} className={open ? "feedback__item is-open" : "feedback__item"}>
                    <button
                      type="button"
                      className="feedback__itembtn"
                      aria-expanded={open}
                      onClick={() => toggleOpen(key)}
                    >
                      <div className="feedback__itemhead">
                        <span className={`feedback__chip feedback__chip--${report.category}`}>
                          {categoryLabels[report.category] ?? report.category}
                        </span>
                        {report.severity ? (
                          <span className={`feedback__severity feedback__severity--${report.severity}`}>
                            {severityLabels[report.severity] ?? report.severity}
                          </span>
                        ) : null}
                        <span className={`feedback__status feedback__status--${report.status}`}>
                          {statusLabels[report.status] ?? report.status}
                        </span>
                        {report.admin_notes ? (
                          <span className="feedback__replied" title="NPL has replied"><Reply size={12} /> Reply</span>
                        ) : null}
                        <time>{reportStamp(report.created_at)}</time>
                        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </div>
                      <strong className="feedback__subject">{report.subject}</strong>
                    </button>

                    {open ? (
                      <div className="feedback__body">
                        <p>{report.message}</p>
                        <small className="feedback__meta">
                          {report.author_name ?? "Venue desk"}
                          {report.venue_name ? ` · ${report.venue_name}` : ""}
                          {report.os_version ? ` · OS ${report.os_version}` : ""}
                        </small>
                        {report.admin_notes ? (
                          <div className="feedback__reply">
                            <span><Reply size={13} /> NPL replied{report.handled_at ? ` · ${reportStamp(report.handled_at)}` : ""}</span>
                            <p>{report.admin_notes}</p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      </section>
    </div>
  )
}
