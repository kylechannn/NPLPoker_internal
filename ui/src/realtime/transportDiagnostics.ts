/** Numeric aggregates only; never store identifiers, URLs, payloads or errors. */
export const transportHistogramBounds = [100, 300, 1000, 3000, 10000, "inf"] as const
const counterNames = ["socket_attempts", "reconnects", "subscriptions", "session_signals", "deduped_signals", "targeted_batches", "full_pulls", "targets", "failed_pulls", "retries"] as const
type Counter = typeof counterNames[number]
type Bucket = { counters: Record<Counter, number>, duration_buckets: number[], duration_sum_ms: number, duration_max_ms: number }
const empty = (): Bucket => ({ counters: Object.fromEntries(counterNames.map(key => [key, 0])) as Record<Counter, number>, duration_buckets: [0, 0, 0, 0, 0, 0], duration_sum_ms: 0, duration_max_ms: 0 })

export function createTransportDiagnostics(now: () => number = Date.now) {
  const minutes = new Map<number, Bucket>()
  function prune() {
    const minute = Math.floor(now() / 60000)
    for (const key of minutes.keys()) if (key < minute - 59 || key > minute) minutes.delete(key)
    return minute
  }
  function bucket() {
    const minute = prune()
    if (!minutes.has(minute)) minutes.set(minute, empty())
    return minutes.get(minute)!
  }
  return {
    count(name: Counter, value = 1) {
      try {
        if (!counterNames.includes(name) || !Number.isFinite(value) || value < 0) return
        bucket().counters[name] += Math.min(1000000, Math.floor(value))
      } catch { /* Observability cannot affect the transport. */ }
    },
    duration(milliseconds: number) {
      try {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return
        const ms = Math.min(600000, Math.round(milliseconds)), row = bucket()
        const index = transportHistogramBounds.findIndex(bound => bound === "inf" || ms <= bound)
        row.duration_buckets[index]++
        row.duration_sum_ms += ms
        row.duration_max_ms = Math.max(row.duration_max_ms, ms)
      } catch { /* Observability cannot affect the transport. */ }
    },
    snapshot() {
      prune()
      const total = empty()
      for (const row of minutes.values()) {
        for (const key of counterNames) total.counters[key] += row.counters[key]
        row.duration_buckets.forEach((value, index) => { total.duration_buckets[index] += value })
        total.duration_sum_ms += row.duration_sum_ms
        total.duration_max_ms = Math.max(total.duration_max_ms, row.duration_max_ms)
      }
      return { schema_version: 1, window_minutes: 60, generated_at: new Date(now()).toISOString(), histogram_bounds_ms: transportHistogramBounds, ...total }
    },
  }
}

export const transportDiagnostics = createTransportDiagnostics()

export type CloudTransportMetrics = {
  schema_version: 1
  window_minutes: number
  generated_at: string
  available: boolean
  histogram_bounds_ms: Array<number | string>
  families: Array<{
    family: string, requests: number, attempts: number, not_modified: number, errors: number, skipped: number,
    response_body_bytes: number, duration_sum_ms: number, duration_max_ms: number, duration_buckets: number[]
  }>
  backlog: null | {
    cash_ack_pending: number, cash_ack_oldest_age_seconds: number | null,
    outbox_pending: number, outbox_dead: number, cloud_pending: number, cloud_dead: number
  }
}
