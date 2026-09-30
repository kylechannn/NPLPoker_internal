import { useEffect, useRef, useState, type FormEvent } from "react"
import { Camera, Clock3, ShieldCheck, Upload } from "lucide-react"
import { wheelApi, WheelApiError, type WheelApproval, type WheelPlayer, type WheelTier } from "./wheelApi"

export type WheelOperator = {
  id: string; name: string; role: string; initials: string; role_key?: string; super_admin?: boolean
  admin_token?: string | null; admin_token_expires_at?: string | null
}

export const wheelApprovalStorageKey = (operatorId: string, nplId: string, venueId: number | null, wheel: WheelTier, parentReference: string | null) =>
  `npl.wheelApproval:${operatorId}:${nplId}:${venueId ?? ""}:${wheel}:${parentReference ?? ""}`

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

export default function WheelApprovalGate({ player, wheel, parentReference, venueId, token, operatorId, onApproved, onBack, onAuthExpired }: {
  player: WheelPlayer; wheel: WheelTier; parentReference: string | null; venueId: number | null; token: string; operatorId: string
  onApproved: (approval: WheelApproval) => void; onBack: () => void; onAuthExpired: () => void
}) {
  const storageKey = wheelApprovalStorageKey(operatorId, player.npl_id, venueId, wheel, parentReference)
  const [approval, setApproval] = useState<WheelApproval | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as WheelApproval | null } catch { return null }
  })
  const [reference, setReference] = useState(() => approval?.reference ?? `WS-${crypto.randomUUID()}`)
  const [photo, setPhoto] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [preparing, setPreparing] = useState(false)
  const [camera, setCamera] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const mounted = useRef(true)
  const callbacks = useRef({ onApproved, onAuthExpired })
  useEffect(() => { callbacks.current = { onApproved, onAuthExpired } }, [onApproved, onAuthExpired])

  useEffect(() => {
    const url = photo ? URL.createObjectURL(photo) : null
    setPreview(url)
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [photo])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; stream.current?.getTracks().forEach((track) => track.stop()) } }, [])
  useEffect(() => {
    if (camera && video.current) { video.current.srcObject = stream.current; void video.current.play().catch(() => setError("Camera preview could not start. Choose a photo instead.")) }
  }, [camera])
  useEffect(() => {
    if (!approval?.id) return
    let alive = true
    const check = async () => {
      try {
        const fresh = await wheelApi.approval(approval.id, token)
        if (!alive) return
        setApproval(fresh); setError(null)
        sessionStorage.setItem(storageKey, JSON.stringify(fresh))
        if (fresh.status === "approved" || fresh.status === "consumed") callbacks.current.onApproved(fresh)
      } catch (e) {
        if (!alive) return
        if (e instanceof WheelApiError && e.status === 401) callbacks.current.onAuthExpired()
        setError(e instanceof Error ? e.message : "Could not refresh approval. Retrying…")
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), 5000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [approval?.id, token, storageKey])

  async function choose(file: File | null) {
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 6 * 1024 * 1024) {
      setError("Choose a JPG, PNG or WebP photo up to 6 MB."); return
    }
    setPreparing(true); setPhoto(null); setError(null)
    try {
      // Keep phone photos below portable PHP's usual 2 MB upload limit.
      // Smaller images retain their original pixels; large ones are resized.
      if (file.size <= 1_500_000) { setPhoto(file); return }
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement("canvas")
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82))
      if (!blob || blob.size > 1_500_000) throw new Error("Choose a smaller, clear hand photo.")
      if (mounted.current) setPhoto(new File([blob], "hand.jpg", { type: "image/jpeg" }))
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "This photo could not be read.") }
    finally { if (mounted.current) setPreparing(false) }
  }
  function stopCamera() { stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; setCamera(false) }
  async function startCamera() {
    try {
      const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
      if (!mounted.current) { opened.getTracks().forEach((track) => track.stop()); return }
      stream.current?.getTracks().forEach((track) => track.stop())
      stream.current = opened; setCamera(true); setError(null)
    }
    catch { setError("Camera unavailable. Allow camera access or choose a hand photo.") }
  }
  function takePhoto() {
    const current = video.current
    if (!current?.videoWidth) return
    const canvas = document.createElement("canvas")
    const scale = Math.min(1, 1600 / current.videoWidth)
    canvas.width = current.videoWidth * scale; canvas.height = current.videoHeight * scale
    canvas.getContext("2d")?.drawImage(current, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => { if (blob) { choose(new File([blob], "hand.jpg", { type: "image/jpeg" })); stopCamera() } }, "image/jpeg", 0.85)
  }
  async function submit() {
    if (!photo || busy || preparing) return
    setBusy(true); setError(null)
    const form = new FormData()
    form.set("reference", reference); form.set("npl_id", player.npl_id); form.set("wheel", wheel); form.set("photo", photo)
    if (venueId) form.set("venue_id", String(venueId))
    if (parentReference) form.set("parent_reference", parentReference)
    try {
      const result = await wheelApi.requestApproval(form, token)
      sessionStorage.setItem(storageKey, JSON.stringify(result)); setApproval(result)
    } catch (e) {
      if (e instanceof WheelApiError && e.status === 401) onAuthExpired()
      setError(e instanceof Error ? e.message : "Request failed. Please retry.")
    } finally { setBusy(false) }
  }
  const expired = approval && new Date(approval.expires_at).getTime() <= now
  const ended = approval && (expired || approval.status === "rejected" || approval.status === "expired")
  const remaining = approval ? Math.max(0, Math.ceil((new Date(approval.expires_at).getTime() - now) / 1000)) : 0
  return <div className="jackpot-wheel-view"><section className="wheel-scan-card wheel-approval" aria-label="Wheel spin verification">
    <ShieldCheck size={30} /><p className="wheel-scan-card__kicker">{wheel === "golden" ? "Golden wheel verification" : "Wheel verification"}</p>
    <h1>{approval ? ended ? "A new request is needed" : "Waiting for Super Admin" : "Photograph the qualifying hand"}</h1>
    <p><strong>{player.display_name}</strong> · {player.npl_id}</p>
    {!approval ? <>
      <p>Show the cards clearly. A Super Admin must approve this spin. Approval and the spin must happen within 15 minutes of submission.</p>
      {camera ? <><video ref={video} muted playsInline className="wheel-approval__photo" /><div className="wheel-approval__actions"><button onClick={takePhoto}>Take photo</button><button onClick={stopCamera}>Cancel camera</button></div></> : <div className="wheel-approval__actions">
        <button onClick={() => void startCamera()}><Camera size={17} /> Use camera</button>
        <label className="wheel-approval__upload"><Upload size={17} /> Choose photo<input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => choose(event.target.files?.[0] ?? null)} /></label>
      </div>}
      {preview && <img src={preview} alt="Hand photo to submit for approval" className="wheel-approval__photo" />}
      <button onClick={() => void submit()} disabled={!photo || busy || camera || preparing}>{preparing ? "Preparing photo…" : busy ? "Submitting…" : "Request this spin"}</button>
    </> : <>
      {!ended && <p role="status"><Clock3 size={16} /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")} remaining · This page opens the wheel as soon as approval arrives.</p>}
      {ended && <><p>{approval.status === "rejected" ? `Declined${approval.review_note ? `: ${approval.review_note}` : "."}` : "The 15-minute window expired. Take a new photo to request another approval."}</p><button onClick={() => { sessionStorage.removeItem(storageKey); setApproval(null); setPhoto(null); setReference(`WS-${crypto.randomUUID()}`); setError(null) }}>Start a new request</button></>}
    </>}
    {error && <p className="wheel-scan-card__error" role="alert">{error}</p>}
    <button className="wheel-approval__back" onClick={onBack} disabled={busy}>Back to player scan</button>
  </section></div>
}
