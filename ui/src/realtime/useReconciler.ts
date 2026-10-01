import { useCallback, useEffect, useMemo, useRef } from "react"
import { createReconciler } from "./reconciler"

/** The identity is the local session, not a mutable selection read after await. */
export function useReconciler(identity: number | string, run: (isCurrent: () => boolean) => Promise<void>) {
  const latest = useRef(run)
  latest.current = run
  const owner = useRef(identity)
  owner.current = identity
  const reconciler = useMemo(() => createReconciler(isCurrent => {
    if (owner.current !== identity) return Promise.resolve()
    return latest.current(() => isCurrent() && owner.current === identity)
  }), [identity])
  useEffect(() => {
    reconciler.resume()
    return () => reconciler.stop()
  }, [reconciler])
  return useCallback(() => reconciler.request(), [reconciler])
}
