import { useCallback, useEffect, useState, type ReactNode } from "react"
import { KeyRound, Loader2, ShieldCheck, ShieldAlert } from "lucide-react"
import nplLogoUrl from "./assets/npl-logo.png"

type Lease = {
  uuid: string
  label: string | null
  product: string
  venue_name: string | null
  status: string
  expires_at: string | null
  lease_until: string | null
  device_id: string
  device_label: string | null
}

export type LicenseStatus = {
  activated: boolean
  valid: boolean
  masked_key: string
  device_id: string
  lease: Lease | null
  lease_valid: boolean
  message: string
  cloud_base: string
}

/**
 * Blocks the operational system until this install holds a valid CD-Key
 * lease. Unlike the EdgeHost original — where an unlicensed host still ran
 * and merely failed to sync — nothing here is reachable until the lease is
 * valid, and the lease is re-checked in the background so a revoked key
 * locks the desk at its next check.
 */
export default function LicenseGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [keyInput, setKeyInput] = useState("")
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/license/status", { headers: { Accept: "application/json" } })
      setStatus((await response.json()) as LicenseStatus)
    } catch {
      setError("Could not read the local licence state.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Re-validate in the background so a revoked key stops working.
  useEffect(() => {
    if (!status?.activated) return
    const timer = window.setInterval(() => {
      void fetch("/api/license/check", { method: "POST" })
        .then((response) => response.json())
        .then((body: LicenseStatus | { status: LicenseStatus }) => {
          setStatus("status" in body ? body.status : body)
        })
        .catch(() => undefined)
    }, 6 * 60 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [status?.activated])

  async function activate(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError(null)

    try {
      const response = await fetch("/api/license/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ key: keyInput.trim().toUpperCase() }),
      })
      const body = await response.json()

      if (!response.ok) {
        setError(body?.error ?? "Activation was refused.")
        if (body?.status) setStatus(body.status as LicenseStatus)
        return
      }

      setStatus(body as LicenseStatus)
      setKeyInput("")
    } catch {
      setError("Could not reach the NPL licence server. Check this machine's internet connection.")
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="npl-license-gate">
        <Loader2 className="npl-license-gate__spinner" size={28} />
      </div>
    )
  }

  if (status?.valid) return <>{children}</>

  const expiredLease = Boolean(status?.activated && !status.valid)

  return (
    <div className="npl-license-gate">
      <form className="npl-license-gate__card" onSubmit={activate}>
        <img src={nplLogoUrl} alt="" className="npl-license-gate__logo" />
        <h1>NPL Poker Internal</h1>

        {expiredLease ? (
          <p className="npl-license-gate__lead npl-license-gate__lead--warn">
            <ShieldAlert size={16} aria-hidden="true" />
            This licence needs to be re-checked. Reconnect this machine to the internet, or enter a new CD-Key.
          </p>
        ) : (
          <p className="npl-license-gate__lead">
            <KeyRound size={16} aria-hidden="true" />
            Enter the CD-Key supplied by NPL to activate this install.
          </p>
        )}

        <label className="npl-license-gate__field">
          <span>CD-Key</span>
          <input
            value={keyInput}
            onChange={(event) => setKeyInput(event.target.value.toUpperCase())}
            placeholder="NPL-XXXX-XXXX-XXXX"
            spellCheck={false}
            autoComplete="off"
            disabled={submitting}
            required
          />
        </label>

        {error ? <p className="npl-license-gate__error" role="alert">{error}</p> : null}

        <button type="submit" className="npl-license-gate__submit" disabled={submitting || keyInput.trim().length < 6}>
          {submitting ? "Activating…" : "Activate this device"}
        </button>

        <dl className="npl-license-gate__meta">
          <div>
            <dt>Device ID</dt>
            <dd>{status?.device_id ?? "—"}</dd>
          </div>
          {status?.masked_key ? (
            <div>
              <dt>Current key</dt>
              <dd>{status.masked_key}</dd>
            </div>
          ) : null}
          <div>
            <dt>Licence server</dt>
            <dd>{status?.cloud_base ?? "—"}</dd>
          </div>
        </dl>

        <p className="npl-license-gate__foot">
          <ShieldCheck size={14} aria-hidden="true" />
          Each key covers a set number of devices. Ask NPL support to release a slot if you are moving this install.
        </p>
      </form>
    </div>
  )
}
