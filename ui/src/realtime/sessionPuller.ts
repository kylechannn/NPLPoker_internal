import { createReconciler } from "./reconciler"
import type { SessionUpdate } from "./sessionUpdates"

/** Retains missed targets across failures and fences a previous venue's response. */
export function createSessionPuller(
  pull: (update: SessionUpdate) => Promise<void>,
  publish: (update: SessionUpdate) => void,
  scheduleRetry?: (retry: () => void) => () => void,
) {
  let venueId: number | null = null
  let generation = 0
  let full = false
  const targets = new Set<number>()
  let cancelRetry: (() => void) | undefined
  const worker = createReconciler(async isCurrent => {
    cancelRetry?.()
    cancelRetry = undefined
    const owner = generation
    const update: SessionUpdate = {
      venueId,
      sessionIds: full || targets.size === 0 || targets.size > 20 ? null : [...targets],
    }
    full = false
    targets.clear()
    try {
      await pull(update)
      if (isCurrent() && owner === generation) publish(update)
    } catch (error) {
      if (isCurrent() && owner === generation) {
        if (update.sessionIds === null) full = true
        else update.sessionIds.forEach(id => targets.add(id))
        if (scheduleRetry) cancelRetry = scheduleRetry(() => {
          cancelRetry = undefined
          void worker.request().catch(() => {})
        })
      }
      throw error
    }
  })

  return {
    setVenue(next: number | null) {
      if (venueId === next) return
      worker.stop()
      cancelRetry?.()
      cancelRetry = undefined
      generation += 1
      venueId = next
      full = false
      targets.clear()
      if (next !== null) worker.resume()
    },
    request(sessionId?: number) {
      if (venueId === null) return Promise.resolve()
      if (sessionId === undefined) full = true
      else targets.add(sessionId)
      return worker.request()
    },
  }
}
