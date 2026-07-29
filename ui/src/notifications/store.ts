import { useSyncExternalStore } from "react"

/**
 * The operations notice ledger. Every OS-level event a floor manager may
 * need to look back on lands here — desk registrations, online bookings
 * arriving, backend-link state changes, finished games — and persists
 * across restarts so "who bought in tonight" survives an accidental app
 * close. The notification panel renders it with category sub-tabs.
 */

export type NoticeCategory = "registration" | "system"

export type NoticeTone = "info" | "success" | "warning"

export type Notice = {
  id: string
  category: NoticeCategory
  tone: NoticeTone
  title: string
  detail: string
  at: string
}

const STORAGE_KEY = "npl.notices.v1"
const MAX_NOTICES = 300

let notices: Notice[] = load()
const listeners = new Set<() => void>()

function load(): Notice[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Notice[]
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTICES) : []
  } catch {
    return []
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(notices.slice(0, MAX_NOTICES)))
  } catch {
    // Full storage never blocks operations; the in-memory list stands.
  }
}

export function notify(category: NoticeCategory, title: string, detail: string, tone: NoticeTone = "info") {
  notices = [
    {
      id: crypto.randomUUID(),
      category,
      tone,
      title,
      detail,
      at: new Date().toISOString(),
    },
    ...notices,
  ].slice(0, MAX_NOTICES)

  persist()
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useNotices(): Notice[] {
  return useSyncExternalStore(subscribe, () => notices)
}

export function noticeTime(notice: Notice): string {
  const parsed = new Date(notice.at)
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}
