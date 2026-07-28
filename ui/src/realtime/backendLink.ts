import { useCallback, useEffect, useRef, useState } from "react"

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
}

const FALLBACK_PULL_MS = 60_000
const STALE_SOCKET_MS = 150_000
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 30_000

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, ...init })
  const body = await response.json().catch(() => null) as { ok?: boolean, data?: T, error?: { message?: string } } | null
  if (!response.ok || !body?.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`)
  return body.data as T
}

/** Pull sessions + seat maps now; tell every open workspace when done. */
export async function pullSessionsNow(): Promise<void> {
  await fetchJson("/api/v1/sync/pull-sessions", { method: "POST" })
  window.dispatchEvent(new CustomEvent("npl:sessions-updated"))
}

export function useBackendLink(venueId: number | null) {
  const [status, setStatus] = useState<BackendLinkStatus>("off")
  const [enabled, setEnabled] = useState(true)
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

      let details: RealtimeDetails
      try {
        details = await fetchJson<RealtimeDetails>("/api/v1/sync/realtime")
        if (!details.key || !details.host) throw new Error("Realtime endpoint returned no connection details")
      } catch {
        if (!disposed) {
          setStatus("off")
          scheduleReconnect()
        }
        return
      }

      if (disposed) return

      const protocol = details.scheme === "https" ? "wss" : "ws"
      const socket = new WebSocket(
        `${protocol}://${details.host}:${details.port}/app/${details.key}?protocol=7&client=npl-os&version=1.0&flash=false`,
      )
      socketRef.current = socket
      lastFrameRef.current = Date.now()

      socket.onopen = () => {
        lastFrameRef.current = Date.now()
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
          socket.send(JSON.stringify({
            event: "pusher:subscribe",
            data: { channel: `${details.channel_prefix}${venueId}` },
          }))
          attemptRef.current = 0
          setStatus("connected")
          // Catch up on anything that happened while the link was down.
          void pullSessionsNow().catch(() => {})
          return
        }

        if (message?.event === "pusher:ping") {
          socket.send(JSON.stringify({ event: "pusher:pong", data: {} }))
          return
        }

        if (message?.event === "session.touched") {
          void pullSessionsNow().catch(() => {})
        }
      }

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null
        if (!disposed) {
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
  // most a minute stale.
  useEffect(() => {
    if (venueId === null) return

    const timer = window.setInterval(() => {
      if (statusRef.current !== "connected") {
        void pullSessionsNow().catch(() => {})
      }
    }, FALLBACK_PULL_MS)

    return () => window.clearInterval(timer)
  }, [venueId])

  const toggle = useCallback(() => {
    setEnabled((current) => !current)
  }, [])

  return { status: venueId === null ? "off" as const : status, enabled, toggle }
}
