import { createReconciler } from "./reconciler"
import type { SessionUpdate } from "./sessionUpdates"

/** Retains missed targets across failures and fences a previous venue's response. */
export function createSessionPuller(
  pull: (update: SessionUpdate) => Promise<void>,
  publish: (update: SessionUpdate) => void,
  scheduleRetry?: (retry: () => void) => () => void,
  scheduleBatch?: (flush: () => void) => () => void,
) {
  let venueId: number | null = null
  let generation = 0
  let full = false
  const targets = new Set<number>()
  let cancelRetry: (() => void) | undefined
  let batch: { promise: Promise<void>, cancel: () => void, resolve: () => void } | undefined
  const worker = createReconciler(async isCurrent => {
    cancelRetry?.()
    cancelRetry = undefined
    const owner = generation
    const update: SessionUpdate = {
      venueId,
      sessionIds: full || targets.size === 0 ? null : [...targets].sort((a, b) => a - b).slice(0, 20),
    }
    full = false
    if (update.sessionIds === null) targets.clear()
    else update.sessionIds.forEach(id => targets.delete(id))
    try {
      await pull(update)
      if (isCurrent() && owner === generation) publish(update)
      // A burst spanning more than one batch stays targeted. Do not turn 21
      // changed sessions into a full venue sweep of unrelated seat maps.
      if (isCurrent() && owner === generation && targets.size > 0 && !batch) void worker.request().catch(() => {})
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
      batch?.cancel()
      batch?.resolve()
      batch = undefined
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
      if (!scheduleBatch) return worker.request()
      if (batch) return batch.promise
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
      const cancel = scheduleBatch(() => {
        batch = undefined
        void worker.request().then(resolve, reject)
      })
      batch = { promise, cancel, resolve }
      return promise
    },
  }
}
