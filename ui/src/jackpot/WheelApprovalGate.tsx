import { useEffect, useRef, useState, type FormEvent } from "react"
import { Clock3, ShieldCheck, Smartphone } from "lucide-react"
import { wheelApi, WheelApiError, type WheelApproval, type WheelPlayer, type WheelTier, type WheelSession } from "./wheelApi"

export type WheelOperator = {
  id: string; name: string; role: string; initials: string; role_key?: string; super_admin?: boolean
  admin_token?: string | null; admin_token_expires_at?: string | null
}

export const wheelApprovalStorageKey = (operatorId: string, nplId: string, venueId: number | null, wheel: WheelTier, parentReference: string | null, sessionUid: string | null = null) =>
  `npl.wheelApproval:${operatorId}:${nplId}:${venueId ?? ""}:${wheel}:${parentReference ?? ""}:${sessionUid ?? ""}`

export function WheelOperatorSignIn({ staff, onSignedIn }: { staff: WheelOperator; onSignedIn: (value: WheelOperator) => void }) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true); setError(null)
    try {
      const response = await fetch("/api/v1/console/login", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ login: staff.id, password }) })
      const body = await response.json() as { ok?: boolean; data?: { identity: WheelOperator }; error?: { message?: string } }
      if (!response.ok || !body.ok || !body.data?.identity.admin_token) throw new Error(body.error?.message ?? "Please sign in again.")
      onSignedIn(body.data.identity)
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed.") }
    finally { setBusy(false) }
  }
  return <div className="jackpot-wheel-view"><form className="wheel-scan-card wheel-approval" onSubmit={(event) => void submit(event)}>
    <ShieldCheck size={30} /><h1>Confirm your sign-in</h1>
    <p>The wheel verifies each operator. Enter the password for <strong>{staff.id}</strong> to continue.</p>
    <label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required autoFocus /></label>
    {error && <p role="alert" className="wheel-scan-card__error">{error}</p>}
    <button disabled={busy || !password}>{busy ? "Signing in…" : "Continue"}</button>
  </form></div>
}

export default function WheelApprovalGate({ player, wheel, parentReference, venueId, session, token, operatorId, onApproved, onBack, onAuthExpired }: {
  player: WheelPlayer; wheel: WheelTier; parentReference: string | null; venueId: number | null; session: WheelSession | null; token: string; operatorId: string
  onApproved: (approval: WheelApproval) => void; onBack: () => void; onAuthExpired: () => void
}) {
  const storageKey = wheelApprovalStorageKey(operatorId, player.npl_id, venueId, wheel, parentReference, session?.tournament_uid ?? null)
  const [approval, setApproval] = useState<WheelApproval | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as WheelApproval | null } catch { return null }
  })
  // Persist before sending: even a lost creation response retries the same request.
  const [reference, setReference] = useState(() => approval?.reference ?? sessionStorage.getItem(`${storageKey}:reference`) ?? `WS-${crypto.randomUUID()}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const callbacks = useRef({ onApproved, onAuthExpired })
  useEffect(() => { callbacks.current = { onApproved, onAuthExpired } }, [onApproved, onAuthExpired])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    if (!approval?.id) return
    let alive = true
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const fresh = await wheelApi.approval(approval.id, token)
        if (!alive) return
        setApproval(fresh); setError(null)
        sessionStorage.setItem(storageKey, JSON.stringify(fresh))
        if (fresh.status === "approved" || fresh.status === "consumed") callbacks.current.onApproved(fresh)
      } catch (e) {
        if (!alive) return
        if (e instanceof WheelApiError && e.status === 401) callbacks.current.onAuthExpired()
        setError(e instanceof Error ? e.message : "Could not refresh the request. Retrying…")
      } finally { checking = false }
    }
    const touched = (event: Event) => {
      if ((event as CustomEvent<{ approval_id?: number }>).detail?.approval_id === approval.id) void check()
    }
    void check()
    const timer = window.setInterval(() => void check(), 5000)
    window.addEventListener("npl:wheel-approval-updated", touched)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("npl:wheel-approval-updated", touched) }
  }, [approval?.id, token, storageKey])

  async function submit() {
    if (!session || busy) return
    setBusy(true); setError(null)
    sessionStorage.setItem(`${storageKey}:reference`, reference)
    try {
      const result = await wheelApi.requestApproval({ reference, npl_id: player.npl_id, wheel, parent_reference: parentReference, tournament_uid: session.tournament_uid }, token)
      sessionStorage.setItem(storageKey, JSON.stringify(result)); setApproval(result)
    } catch (e) {
      if (e instanceof WheelApiError && e.status === 401) onAuthExpired()
      setError(e instanceof Error ? e.message : "Request failed. Retry to recover the same request.")
    } finally { setBusy(false) }
  }
  const expired = approval && new Date(approval.expires_at).getTime() <= now && approval.status !== "consumed"
  const ended = approval && (expired || approval.status === "rejected" || approval.status === "expired")
  const waitingPhoto = approval?.status === "awaiting_photo"
  const remaining = approval ? Math.max(0, Math.ceil((new Date(approval.expires_at).getTime() - now) / 1000)) : 0
  return <div className="jackpot-wheel-view"><section className="wheel-scan-card wheel-approval" aria-label="Wheel spin verification">
    <ShieldCheck size={30} /><p className="wheel-scan-card__kicker">{wheel === "golden" ? "Golden wheel verification" : "Wheel verification"}</p>
    <h1>{approval ? ended ? "A new request is needed" : waitingPhoto ? "Take the hand photo on your phone" : "Waiting for Super Admin" : "Send a photo request to your phone"}</h1>
    <p><strong>{player.display_name}</strong> · {player.npl_id}</p>
    <p><Smartphone size={18} /> {approval?.session_name ?? session?.name ?? "No active session"}</p>
    {!approval ? <>
      <p>Bind the staff phone using this session’s Admin QR. Then open Wheel photo requests in the iOS or Android app, take a clear hand photo and submit it for Super Admin approval.</p>
      <p>The photo, approval and start of the spin must all happen within 15 minutes of creating this request.</p>
      {!session && <p role="alert">Open a session on the OS first, then scan the player again.</p>}
      <button onClick={() => void submit()} disabled={!session || busy}>{busy ? "Sending…" : "Send photo request to phone"}</button>
    </> : <>
      {!ended && <>
        <p>{waitingPhoto ? "A notification has been requested for staff phones bound to this session. You can also open Wheel photo requests directly in the app." : "The hand photo has been submitted. This page unlocks the wheel when a Super Admin approves."}</p>
        <p role="status"><Clock3 size={16} /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} remaining · Keep this page open.</p>
      </>}
      {ended && <><p>{approval.status === "rejected" ? `Declined${approval.review_note ? `: ${approval.review_note}` : "."}` : "The 15-minute window expired. Start a new request and submit a new photo from the phone."}</p><button onClick={() => { sessionStorage.removeItem(storageKey); sessionStorage.removeItem(`${storageKey}:reference`); setApproval(null); setReference(`WS-${crypto.randomUUID()}`); setError(null) }}>Start a new request</button></>}
    </>}
    {error && <p className="wheel-scan-card__error" role="alert">{error}</p>}
    <button className="wheel-approval__back" onClick={onBack} disabled={busy}>Back to player scan</button>
  </section></div>
}
