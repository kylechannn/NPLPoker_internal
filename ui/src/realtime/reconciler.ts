/** One HTTP reconciliation at a time, with one trailing pass for any burst.
 * A stopped owner can finish its request, but cannot apply its result. */
export function createReconciler(run: (isCurrent: () => boolean) => Promise<void>) {
  let active = true
  let generation = 0
  let pending = false
  let flight: Promise<void> | null = null

  const request = (): Promise<void> => {
    if (!active) return Promise.resolve()
    pending = true
    if (flight) return flight
    flight = (async () => {
      while (active && pending) {
        pending = false
        const owner = generation
        await run(() => active && owner === generation)
      }
    })().finally(() => {
      flight = null
      // A failed pass must not discard a signal received while it ran.
      if (active && pending) void request().catch(() => {})
    })
    return flight
  }

  return {
    request,
    stop() { active = false; generation += 1; pending = false },
    resume() { active = true },
  }
}
