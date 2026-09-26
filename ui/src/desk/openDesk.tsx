import { useCallback, useEffect, useState, type ReactNode } from "react"
import { deskApi, type ActiveSession, type Venue } from "./deskApi"

export type DeskMode = "tournament" | "cash"

type PendingReplace = {
  active: ActiveSession
  mode: DeskMode
  gameSessionId: number | null
}

/**
 * Opening a desk straight from the game structure defaults — no
 * preparation screen. The night's facts (which cloud session, which venue)
 * go to the local app, which builds the whole session from the super
 * admin's base setup and answers with the draft to run.
 *
 * One session at a time still holds: an unfinished session must be erased
 * explicitly, so the operator is asked before it goes — with a FRESH read
 * of what is open, never a stale snapshot.
 */
export function useOpenDesk(venue: Venue | null, onOpened: (localSessionId: number) => void) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingReplace | null>(null)

  // The defaults a desk is about to open on should be the super admin's
  // latest save: refresh from the cloud while the hub is on screen. Best
  // effort — offline, the mirror stands and the open still works.
  useEffect(() => {
    void deskApi.pullGameStructure().catch(() => undefined)
  }, [])

  const open = useCallback(async (mode: DeskMode, gameSessionId: number | null, replaceSessionId?: number) => {
    if (opening) return
    setError(null)

    if (!venue) {
      setError("Pick a venue in the header before opening a desk.")
      return
    }

    if (replaceSessionId === undefined) {
      const active = await deskApi.activeSession().catch(() => null)
      if (active) {
        setPending({ active, mode, gameSessionId })
        return
      }
    }

    setOpening(true)
    try {
      const created = await deskApi.openSession({
        game_type: mode,
        game_session_id: gameSessionId,
        venue_id: venue.id,
        venue_name: venue.name,
        ...(replaceSessionId !== undefined ? { replace_session_id: replaceSessionId } : {}),
      })
      // The sidebar admin QR appears the moment the session exists.
      window.dispatchEvent(new CustomEvent("npl:desk-session-changed"))
      onOpened(created.session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The desk could not be opened.")
    } finally {
      setOpening(false)
    }
  }, [opening, venue, onOpened])

  const dialog: ReactNode = pending ? (
    <div className="host-scan-modal" role="presentation" onMouseDown={() => setPending(null)}>
      <section className="host-scan-modal__panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3 className="host-finish__confirm-title">Erase the open session?</h3>
        <p className="host-finish__confirm-copy">
          “{pending.active.name ?? "The current session"}” is still open
          {pending.active.status === "draft" ? "" : " and has already started"}. Opening this desk
          will <strong>erase it from this laptop</strong> — every registration and buy-in recorded on it is
          deleted, with <strong>no way back</strong>. The online game itself stays open, so any desk can
          still host it.
        </p>
        <footer className="host-scan-modal__footer">
          <span className="host-scan-modal__total" />
          <button type="button" className="host-scan-modal__cancel" onClick={() => setPending(null)}>
            Keep that session
          </button>
          <button
            type="button"
            className="host-scan-modal__submit"
            onClick={() => {
              const { active, mode, gameSessionId } = pending
              setPending(null)
              void open(mode, gameSessionId, active.id)
            }}
          >
            Erase it and open
          </button>
        </footer>
      </section>
    </div>
  ) : null

  return { open, opening, error, dialog }
}
