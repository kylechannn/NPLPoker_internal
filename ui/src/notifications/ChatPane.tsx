import { useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { deskApi, type ChatRecentRow, type Venue } from "../desk/deskApi"

/**
 * Read-only feed of cash-game chat pulled from the cloud: table-room lines
 * plus player→TD chat requests. Grouped by session, oldest line first inside
 * each group so a conversation reads top-to-bottom. The desk answers via the
 * cloud tools — nothing is composed here.
 */

function lineTime(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

type ChatGroup = {
  sessionId: number
  title: string
  date: string | null
  lines: ChatRecentRow[]
}

export default function ChatPane({ venue }: { venue: Venue | null }) {
  const [rows, setRows] = useState<ChatRecentRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const venueId = venue?.id ?? null

  useEffect(() => {
    setRows(null)
    setError(null)
    let cancelled = false

    const load = (initial: boolean) => {
      deskApi.chatRecent(venueId)
        .then((result) => {
          if (cancelled) return
          setRows(result)
          setError(null)
        })
        .catch((e) => {
          // A failed background refresh keeps the last good feed; only the
          // first load has nothing to fall back on.
          if (!cancelled && initial) setError(e instanceof Error ? e.message : "Chat could not be loaded.")
        })
    }

    load(true)

    // The backend link fires this on every chat.touched broadcast — a new
    // line lands here the moment the cloud signals it. The interval is the
    // fallback for a quiet or broken socket.
    const onChatTouched = () => load(false)
    window.addEventListener("npl:chat-touched", onChatTouched)
    const interval = window.setInterval(() => load(false), 30_000)

    return () => {
      cancelled = true
      window.removeEventListener("npl:chat-touched", onChatTouched)
      window.clearInterval(interval)
    }
  }, [venueId])

  // The API returns newest first — keep that order for the groups (most
  // recently active session on top) but flip the lines inside each group so
  // conversations read oldest→newest.
  const groups = useMemo<ChatGroup[]>(() => {
    if (!rows) return []
    const bySession = new Map<number, ChatGroup>()
    for (const row of rows) {
      let group = bySession.get(row.game_session_id)
      if (!group) {
        group = {
          sessionId: row.game_session_id,
          title: row.session_title ?? `Session #${row.game_session_id}`,
          date: row.session_date,
          lines: [],
        }
        bySession.set(row.game_session_id, group)
      }
      group.lines.push(row)
    }
    return [...bySession.values()].map((group) => ({ ...group, lines: [...group.lines].reverse() }))
  }, [rows])

  if (error && rows === null) {
    return <p className="chat-pane__error">{error}</p>
  }

  if (rows === null) {
    return (
      <p className="chat-pane__empty">
        <Loader2 size={16} className="chat-pane__spin" />
        <span>Loading chat…</span>
      </p>
    )
  }

  if (groups.length === 0) {
    return <p className="chat-pane__empty">No chat yet — cash-game table rooms and TD requests appear here.</p>
  }

  return (
    <div className="chat-pane">
      {groups.map((group) => (
        <section className="chat-group" key={group.sessionId}>
          <header className="chat-group__head">
            <strong>{group.title}</strong>
            {group.date ? <span>{group.date}</span> : null}
          </header>
          {group.lines.map((row) => {
            const name = row.sender === "td"
              ? (row.sender_name ?? "Director")
              : (row.sender_name ?? row.npl_id ?? "Player")
            return (
              <div className="chat-line" key={row.id}>
                <time className="chat-line__time">{lineTime(row.created_at)}</time>
                <div className="chat-line__content">
                  <div className="chat-line__meta">
                    <span className={row.sender === "td" ? "chat-line__name chat-line__name--td" : "chat-line__name"}>
                      {name}
                    </span>
                    {row.sender === "td" ? <span className="chat-pill chat-pill--td">TD</span> : null}
                    {row.scope === "td" && row.sender === "td" ? (
                      <span className="chat-line__scope">TD → {row.thread?.display_name ?? row.thread?.npl_id ?? "player"}</span>
                    ) : null}
                    {row.scope === "td" && row.sender === "player" ? (
                      <span className="chat-pill chat-pill--request">TD REQUEST</span>
                    ) : null}
                  </div>
                  <p className="chat-line__body">{row.body}</p>
                </div>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}
