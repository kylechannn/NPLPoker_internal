import { useCallback, useEffect, useRef, useState } from "react"
import { notify } from "../notifications/store"

/**
 * The live link to the NPL cloud.
 *
 * One WebSocket, speaking the Pusher wire protocol straight to Reverb (the
 * same server the mobile apps use), subscribed to this venue's channel. The
 * channel only ever carries "session X changed" signals — on each one the
 * UI asks the local backend to pull the fresh session + seat data over
 * HTTP. Signals ride the socket; data rides HTTP where retries, licence
 * auth and offline queueing already live.
 *
 * Lifecycle: connects on app start once a venue is picked, reconnects with
 * backoff after drops, dies with the window. A 60-second fallback pull
 * covers whatever a dead socket missed.
 */

export type BackendLinkStatus = "off" | "connecting" | "connected"

type RealtimeDetails = {
  key: string
  host: string
  port: number
  scheme: string
  channel_prefix: string
  event: string
  /** Advertised chat event name — the endpoint exists so this stays soft. */
  chat_event?: string
}

const FALLBACK_PULL_MS = 60_000
const RECONCILE_PULL_MS = 300_000
const STALE_SOCKET_MS = 150_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 30_000

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, ...init })
  const body = await response.json().catch(() => null) as { ok?: boolean, data?: T, error?: { message?: string } } | null
  if (!response.ok || !body?.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`)
  return body.data as T
}

/**
 * Pull sessions + seat maps now; tell every open workspace when done.
 *
 * Single-flight with a trailing rerun: the pull fans out one HTTP call per
 * scheduled session on the desk's only PHP worker, so a burst of signals
 * (five phones registering in the same minute) must coalesce into at most
 * one running pull plus one queued rerun — never a pile-up that starves
 * the operator's own requests.
 */
let pullInFlight: Promise<void> | null = null
let pullQueued = false
let pullVenueId: number | null = null

export function pullSessionsNow(venueId: number | null = pullVenueId): Promise<void> {
  pullVenueId = venueId

  if (pullInFlight) {
    pullQueued = true
    return pullInFlight
  }

  pullInFlight = (async () => {
    try {
      await fetchJson("/api/v1/sync/pull-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        // Venue-scoped: the seat-map refresh covers the venue's whole
        // scheduled window with a handful of calls.
        body: JSON.stringify({ venue_id: venueId }),
      })
      window.dispatchEvent(new CustomEvent("npl:sessions-updated"))
    } finally {
      pullInFlight = null
      if (pullQueued) {
        pullQueued = false
        void pullSessionsNow().catch(() => {})
      }
    }
  })()

  return pullInFlight
}

export function useBackendLink(venueId: number | null) {
  const [status, setStatus] = useState<BackendLinkStatus>("off")
  const [enabled, setEnabled] = useState(true)
  // Why the light is not green, in words an operator can act on. A silent
  // red light is undiagnosable from a venue floor.
  const [lastError, setLastError] = useState<string | null>(null)
  // Which step of the connect sequence we are on — rendered under the
  // light so a stuck state names itself without anyone hovering.
  const [phase, setPhase] = useState<string | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const attemptRef = useRef(0)
  const lastFrameRef = useRef(Date.now())
  const reconnectTimerRef = useRef<number | null>(null)
  const statusRef = useRef<BackendLinkStatus>("off")
  statusRef.current = status

  const teardown = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const socket = socketRef.current
    socketRef.current = null
    if (socket) {
      socket.onclose = null
      socket.onerror = null
      socket.onmessage = null
      socket.onopen = null
      socket.close()
    }
  }, [])

  useEffect(() => {
    if (!enabled || venueId === null) {
      teardown()
      setStatus("off")
      return
    }

    let disposed = false

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current !== null) return
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attemptRef.current, 4))
      attemptRef.current += 1
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        void open()
      }, delay)
    }

    const open = async () => {
      if (disposed) return
      setStatus("connecting")
      setPhase("Fetching connection details…")

      let details: RealtimeDetails
      try {
        details = await fetchJson<RealtimeDetails>("/api/v1/sync/realtime")
        if (!details.key || !details.host) throw new Error("Realtime endpoint returned no connection details")
        setLastError(null)
      } catch (e) {
        if (!disposed) {
          setLastError(e instanceof Error ? e.message : "The realtime details could not be loaded.")
          setStatus("off")
          scheduleReconnect()
        }
        return
      }

      if (disposed) return

      const protocol = details.scheme === "https" ? "wss" : "ws"
      setPhase(`Opening socket to ${details.host}…`)
      const socket = new WebSocket(
        `${protocol}://${details.host}:${details.port}/app/${details.key}?protocol=7&client=npl-os&version=1.0&flash=false`,
      )
      socketRef.current = socket
      lastFrameRef.current = Date.now()

      // A socket that sits in CONNECTING must not hang the light forever —
      // force it closed so the close code surfaces and the retry runs.
      const connectDeadline = window.setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          setLastError("Socket open timed out after 15s — the connection is being silently dropped (proxy/AV/firewall on this machine).")
          socket.close()
        }
      }, 15_000)

      socket.onopen = () => {
        window.clearTimeout(connectDeadline)
        lastFrameRef.current = Date.now()
        setPhase("Socket open — waiting for the server handshake…")
      }

      socket.onmessage = (frame: MessageEvent<string>) => {
        lastFrameRef.current = Date.now()

        let message: { event?: string, data?: unknown } | null = null
        try {
          message = JSON.parse(frame.data) as { event?: string, data?: unknown }
        } catch {
          return
        }

        if (message?.event === "pusher:connection_established") {
          setPhase(`Handshake done — subscribing to venue ${venueId}…`)
          socket.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { channel: `${details.channel_prefix}${venueId}` },
          }))
          return
        }

        // Green only once the venue channel is actually subscribed — a
        // connected socket with a failed subscription hears nothing, and
        // showing it green would disable the fallback poll exactly when
        // it is needed.
        if (message?.event === "pusher_internal:subscription_succeeded") {
          attemptRef.current = 0
          setLastError(null)
          setPhase(null)
          if (statusRef.current !== "connected") {
            notify("system", "Backend link connected", `Live sync active for venue ${venueId}.`, "success")
          }
          setStatus("connected")
          // Catch up on anything that happened while the link was down.
          void pullSessionsNow(venueId).catch(() => {})
          return
        }

        if (message?.event === "pusher:ping") {
          socket.send(JSON.stringify({ event: "pusher:pong", data: {} }))
          return
        }

        // Server-side rejections (bad app key, over capacity) arrive as
        // pusher:error — name the reason instead of spinning silently. The
        // connection details are re-fetched on every attempt, so a rotated
        // key heals itself on the next cycle.
        if (message?.event === "pusher:error") {
          const data = message.data as { code?: number, message?: string } | undefined
          setLastError(`Realtime server refused the connection${data?.code ? ` (${data.code})` : ""}: ${data?.message ?? "unknown error"}`)
          socket.close()
          return
        }

        if (message?.event === "session.touched") {
          const data = (typeof message.data === "string" ? JSON.parse(message.data) : message.data) as
            | { game_session_id?: number, kind?: string }
            | undefined
          const kind = data?.kind ?? "update"
          const labels: Record<string, string> = {
            register: "Online registration received",
            waitlist: "Online wait-list join",
            cancel: "Online registration cancelled",
            checkin: "Desk check-in reached the cloud",
            seat_change: "Seat map updated",
            table_created: "New table opened",
            table_cancelled: "Table cancelled",
            finished: "Session finished",
          }
          notify(
            kind === "register" || kind === "waitlist" || kind === "cancel" || kind === "checkin" ? "registration" : "system",
            labels[kind] ?? "Session updated",
            `Session #${data?.game_session_id ?? "?"} — syncing now.`,
          )
          void pullSessionsNow(venueId).catch(() => {})
        }

        if (message?.event === (details.chat_event ?? "chat.touched")) {
          let data: { game_session_id?: number, scope?: string, sender?: string } | undefined
          try {
            data = (typeof message.data === "string" ? JSON.parse(message.data) : message.data) as typeof data
          } catch {
            // A malformed payload must not kill the handler — the pane's
            // interval heals whatever a dropped signal missed.
            data = undefined
          }
          // Only player-authored lines raise a notice — the director wrote
          // the TD ones, so telling them about their own message is noise.
          if (data?.sender === "player") {
            notify(
              "chat",
              data?.scope === "td" ? "Chat request for the TD" : "Table chat message",
              `Session #${data?.game_session_id ?? "?"} — open the Chat tab.`,
              data?.scope === "td" ? "warning" : "info",
            )
          }
          // The Chat pane listens for this and re-fetches the feed.
          window.dispatchEvent(new CustomEvent("npl:chat-touched"))
        }
      }

      socket.onclose = (event: CloseEvent) => {
        if (socketRef.current === socket) socketRef.current = null
        if (!disposed) {
          // 1006 = the connection never completed or died abnormally —
          // the close code is the single most diagnostic number we have.
          if (statusRef.current === "connected") {
            notify("system", "Backend link lost", `Socket closed (code ${event.code}) — reconnecting automatically.`, "warning")
          }
          setLastError((current) => current ?? `Socket closed (code ${event.code}${event.reason ? `: ${event.reason}` : ""}) — reconnecting.`)
          setStatus("connecting")
          scheduleReconnect()
        }
      }

      socket.onerror = () => {
        socket.close()
      }
    }

    void open()

    // Watchdog: a socket that has gone quiet past Reverb's ping cadence is
    // dead even if the OS never delivered a close frame (sleep, WiFi swap).
    const watchdog = window.setInterval(() => {
      const socket = socketRef.current
      if (socket && Date.now() - lastFrameRef.current > STALE_SOCKET_MS) {
        socket.close()
      }
    }, 30_000)

    return () => {
      disposed = true
      window.clearInterval(watchdog)
      teardown()
    }
  }, [enabled, venueId, teardown])

  // Fallback: while the socket is anything but green, keep the mirror at
  // most a minute stale. While green, a slow reconciliation pull heals
  // anything a dropped frame ever missed — trust the signal, verify anyway.
  useEffect(() => {
    if (venueId === null) return

    const timer = window.setInterval(() => {
      // navigator.onLine false means no network route at all — a pull would
      // only stall the local PHP worker on connect timeouts. Skipped while
      // the window is backgrounded — the socket connection above isn't
      // gated by visibility, so session.touched events keep pulling data
      // live in the meantime; this is only the fallback for a dead socket.
      if (document.visibilityState === "visible" && statusRef.current !== "connected" && navigator.onLine !== false) {
        void pullSessionsNow(venueId).catch(() => {})
      }
    }, FALLBACK_PULL_MS)

    const reconcile = window.setInterval(() => {
      if (document.visibilityState === "visible" && statusRef.current === "connected") {
        void pullSessionsNow(venueId).catch(() => {})
      }
    }, RECONCILE_PULL_MS)

    return () => {
      window.clearInterval(timer)
      window.clearInterval(reconcile)
    }
  }, [venueId])

  const toggle = useCallback(() => {
    setEnabled((current) => !current)
  }, [])

  return {
    status: venueId === null ? "off" as const : status,
    enabled,
    toggle,
    lastError: venueId === null ? "Pick a venue to connect." : (lastError ?? phase),
  }
}
