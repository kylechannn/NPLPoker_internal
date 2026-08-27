/**
 * Feedback & Reports — bug reports, feedback and feature requests from this
 * desk to NPL head office. Sending goes through the local Laravel app,
 * which queues the cloud call (so it works offline and retries); reading
 * comes live from the cloud with this desk's still-queued reports overlaid.
 */

export type FeedbackCategory = "bug" | "feedback" | "feature" | "other"

export type FeedbackSeverity = "low" | "normal" | "high" | "critical"

export type FeedbackStatus = "new" | "acknowledged" | "resolved" | "closed"

/** One report as the cloud holds it — status and the admin's reply included. */
export type FeedbackReport = {
  id: number
  client_reference: string
  category: FeedbackCategory
  severity: FeedbackSeverity | null
  subject: string
  message: string
  author_name: string | null
  venue_id: number | null
  venue_name: string | null
  os_version: string | null
  status: FeedbackStatus
  admin_notes: string | null
  created_at: string
  handled_at: string | null
}

/** A report still in this desk's cloud call queue — sent, not yet landed. */
export type PendingReport = {
  client_reference: string | null
  category: FeedbackCategory
  subject: string
  created_at: string
}

export type FeedbackFeed = {
  /** False when the cloud could not be reached — the queued list still shows. */
  available: boolean
  reports: FeedbackReport[]
  pending: PendingReport[]
}

export type FeedbackSubmission = {
  category: FeedbackCategory
  severity?: FeedbackSeverity | null
  subject: string
  message: string
  author_name?: string | null
  venue_id?: number | null
  context?: Record<string, unknown> | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string }, errors?: Record<string, string[]> }
    | null

  if (!response.ok || body?.ok === false) {
    // A validation refusal carries the field sentence the operator needs
    // ("The subject may not be greater than 180 characters."), not the
    // generic envelope message.
    const fieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    throw new Error(fieldError ?? body?.error?.message ?? body?.message ?? `Request failed (${response.status})`)
  }

  return (body?.data ?? body) as T
}

export const feedbackApi = {
  submit: (payload: FeedbackSubmission) =>
    request<{ result: { queued: boolean, client_reference: string } }>("/api/v1/feedback", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  feed: () => request<FeedbackFeed>("/api/v1/feedback"),
}

export const categoryLabels: Record<FeedbackCategory, string> = {
  bug: "Bug report",
  feedback: "Feedback",
  feature: "Feature request",
  other: "Other",
}

export const severityLabels: Record<FeedbackSeverity, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
}

export const statusLabels: Record<FeedbackStatus, string> = {
  new: "New",
  acknowledged: "Acknowledged",
  resolved: "Resolved",
  closed: "Closed",
}

/**
 * ISO8601 (cloud rows and queued rows alike carry an offset) → "1 Aug 2026,
 * 7:30 pm" in the desk's local time; an unparseable stamp shows as sent.
 */
export function reportStamp(value: string | null): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date)
}
