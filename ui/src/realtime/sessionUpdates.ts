export type SessionUpdate = { venueId: number | null, sessionIds: number[] | null }

/** An unscoped/legacy catch-up invalidates all desks. IDs are cloud session IDs. */
export function sessionUpdateMatches(event: Event, gameSessionId: number | null): boolean {
  const detail = (event as CustomEvent<SessionUpdate | undefined>).detail
  return !detail?.sessionIds || gameSessionId === null || detail.sessionIds.includes(gameSessionId)
}
