import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react"
import { CloudOff, IdCard, Loader2, Pencil, Plus, ScanLine, Search, Trash2 } from "lucide-react"
import type { Venue } from "../desk/deskApi"
import { membershipApi, type ClubMembership, type ResolvedMember } from "./membershipApi"
import { notify } from "../notifications/store"
import "./membership.css"

type EditorState =
  | { mode: "create" }
  | { mode: "edit", membership: ClubMembership }

/**
 * Club Membership ID — the venue's own member register, distinct from the
 * NPL identity. Every create/edit/remove lands on the NPL cloud first
 * (licence-gated there); the local mirror only feeds the desk badges.
 */
export default function MembershipWorkspace({ venue }: { venue: Venue | null }) {
  const [rows, setRows] = useState<ClubMembership[] | null>(null)
  const [source, setSource] = useState<"cloud" | "mirror">("cloud")
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [removing, setRemoving] = useState<ClubMembership | null>(null)
  const [busy, setBusy] = useState(false)

  const venueId = venue?.id ?? null

  const load = useCallback(async () => {
    if (venueId === null) return
    setLoadError(null)
    try {
      const result = await membershipApi.register(venueId)
      setRows(result.memberships)
      setSource(result.source)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "The register could not be loaded.")
    }
  }, [venueId])

  useEffect(() => {
    setRows(null)
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const query = search.trim().toUpperCase()
    if (!rows) return []
    if (!query) return rows
    return rows.filter((row) =>
      row.club_member_code.toUpperCase().includes(query)
      || row.npl_id.toUpperCase().includes(query)
      || (row.display_name ?? "").toUpperCase().includes(query))
  }, [rows, search])

  if (venue === null) {
    return <p className="membership__empty">Pick a venue in the header to open its club register.</p>
  }

  return (
    <div className="membership">
      <header className="membership__head">
        <div>
          <h3><IdCard size={18} /> Club Membership ID — {venue.name}</h3>
          <p>
            The club's own member register, saved straight to the NPL cloud.
            Players without a valid club ID carry a <span className="club-flag club-flag--inline" /> flag on the desk.
          </p>
        </div>
        <button type="button" className="membership__add" onClick={() => setEditor({ mode: "create" })}>
          <Plus size={15} /> Add club ID
        </button>
      </header>

      {source === "mirror" ? (
        <p className="membership__offline" role="alert">
          <CloudOff size={14} /> Cloud unreachable — showing the last synced copy. Connect the backend link to make changes.
        </p>
      ) : null}
      {loadError ? <p className="membership__error" role="alert">{loadError}</p> : null}

      <label className="membership__search">
        <Search size={15} />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search club ID, NPL ID or name…"
          spellCheck={false}
        />
      </label>

      {rows === null && !loadError ? (
        <p className="membership__empty"><Loader2 size={16} className="host-spin" /> Loading the register…</p>
      ) : filtered.length === 0 ? (
        <p className="membership__empty">
          {rows?.length ? "Nothing matches that search." : "No club IDs yet — add the first member."}
        </p>
      ) : (
        <div className="membership__tablewrap">
          <table className="membership__table">
            <thead>
              <tr><th>Club ID</th><th>Member</th><th>NPL ID</th><th>Status</th><th>Joined</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.cloud_id}>
                  <td><code>{row.club_member_code}</code></td>
                  <td>{row.display_name ?? "—"}</td>
                  <td>{row.npl_id}</td>
                  <td>
                    <span className={`membership__status membership__status--${row.valid ? "valid" : row.status}`}>
                      {row.valid ? "active" : row.status === "active" ? "lapsed" : row.status}
                    </span>
                  </td>
                  <td>{row.joined_at ?? "—"}</td>
                  <td>{row.expires_at ?? "—"}</td>
                  <td className="membership__rowactions">
                    <button type="button" title="Edit" onClick={() => setEditor({ mode: "edit", membership: row })}>
                      <Pencil size={14} />
                    </button>
                    <button type="button" title="Remove" onClick={() => setRemoving(row)}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editor ? (
        <MembershipEditor
          venueId={venue.id}
          state={editor}
          busy={busy}
          setBusy={setBusy}
          onClose={() => setEditor(null)}
          onSaved={(memberships) => {
            setRows(memberships)
            setSource("cloud")
            setEditor(null)
          }}
        />
      ) : null}

      {removing ? (
        <div className="membership-modal" role="dialog" aria-modal="true" aria-label="Remove club ID">
          <div className="membership-modal__card">
            <h4>Remove club ID {removing.club_member_code}?</h4>
            <p>
              {removing.display_name ?? removing.npl_id} loses their {venue.name} membership record on the cloud.
              Their NPL account is not touched.
            </p>
            <div className="membership-modal__actions">
              <button type="button" onClick={() => setRemoving(null)} disabled={busy}>Keep it</button>
              <button
                type="button"
                className="membership-modal__danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  membershipApi.remove(removing.cloud_id, venue.id)
                    .then((result) => {
                      setRows(result.memberships)
                      setSource("cloud")
                      setRemoving(null)
                      notify("system", "Club ID removed", `${removing.club_member_code} — ${removing.display_name ?? removing.npl_id}`, "info")
                    })
                    .catch((e) => notify("system", "Club ID not removed", e instanceof Error ? e.message : "Try again.", "warning"))
                    .finally(() => setBusy(false))
                }}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function MembershipEditor({ venueId, state, busy, setBusy, onClose, onSaved }: {
  venueId: number
  state: EditorState
  busy: boolean
  setBusy: (value: boolean) => void
  onClose: () => void
  onSaved: (memberships: ClubMembership[]) => void
}) {
  const editing = state.mode === "edit" ? state.membership : null

  const [scanValue, setScanValue] = useState("")
  const [scanBusy, setScanBusy] = useState(false)
  const [resolved, setResolved] = useState<ResolvedMember | null>(
    editing
      ? {
          player: { npl_id: editing.npl_id, display_name: editing.display_name ?? editing.npl_id, state_code: null },
          membership: editing,
        }
      : null,
  )
  const [code, setCode] = useState(editing?.club_member_code ?? "")
  const [status, setStatus] = useState<"active" | "inactive" | "expired">(editing?.status ?? "active")
  const [joinedAt, setJoinedAt] = useState(editing?.joined_at ?? new Date().toISOString().slice(0, 10))
  const [expiresAt, setExpiresAt] = useState(editing?.expires_at ?? "")
  const [notes, setNotes] = useState(editing?.notes ?? "")
  const [error, setError] = useState<string | null>(null)

  async function submitScan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const id = scanValue.trim()
    if (!id || scanBusy) return
    setScanBusy(true)
    setError(null)
    try {
      const result = await membershipApi.resolve(venueId, id)
      setResolved(result)
      setScanValue("")
      if (result.membership) {
        // Scanning someone who already holds an ID flips into edit mode.
        setCode(result.membership.club_member_code)
        setStatus(result.membership.status)
        setJoinedAt(result.membership.joined_at ?? new Date().toISOString().slice(0, 10))
        setExpiresAt(result.membership.expires_at ?? "")
        setNotes(result.membership.notes ?? "")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The player could not be found.")
    } finally {
      setScanBusy(false)
    }
  }

  function save() {
    if (!resolved || !code.trim() || busy) return
    setBusy(true)
    setError(null)
    membershipApi.save({
      venue_id: venueId,
      npl_id: resolved.player.npl_id,
      club_member_code: code.trim(),
      status,
      joined_at: joinedAt || null,
      expires_at: expiresAt || null,
      notes: notes.trim() || null,
    })
      .then((result) => {
        notify("system", "Club ID saved", `${code.trim().toUpperCase()} — ${resolved.player.display_name}`, "success")
        onSaved(result.memberships)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The club ID could not be saved."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={editing ? "Edit club ID" : "Add club ID"}>
      <div className="membership-modal__card membership-modal__card--wide">
        <h4>{editing ? `Edit club ID — ${editing.display_name ?? editing.npl_id}` : "Add club ID"}</h4>

        {resolved === null ? (
          <form className="membership-modal__scan" onSubmit={(event) => void submitScan(event)}>
            <input
              value={scanValue}
              onChange={(event) => setScanValue(event.target.value.toUpperCase())}
              placeholder="Scan member card or type NPL ID…"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
            <button type="submit" disabled={scanBusy || !scanValue.trim()}>
              {scanBusy ? <Loader2 size={15} className="host-spin" /> : <ScanLine size={15} />} Find player
            </button>
          </form>
        ) : (
          <div className="membership-modal__player">
            <strong>{resolved.player.display_name}</strong>
            <span>
              {resolved.player.npl_id}
              {resolved.player.state_code ? ` · ${resolved.player.state_code}` : ""}
              {resolved.membership && !editing ? " · already holds a club ID — saving updates it" : ""}
            </span>
            {!editing ? (
              <button type="button" onClick={() => setResolved(null)}>Change player</button>
            ) : null}
          </div>
        )}

        {resolved !== null ? (
          <div className="membership-modal__grid">
            <label>
              <span>Club member ID</span>
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="e.g. SYD-0042"
                spellCheck={false}
                autoFocus={!editing}
              />
            </label>
            <label>
              <span>Status</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="expired">Expired</option>
              </select>
            </label>
            <label>
              <span>Joined</span>
              <input type="date" value={joinedAt} onChange={(event) => setJoinedAt(event.target.value)} />
            </label>
            <label>
              <span>Expires (blank = no expiry)</span>
              <input type="date" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
            </label>
            <label className="membership-modal__notes">
              <span>Notes</span>
              <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional" />
            </label>
          </div>
        ) : null}

        {error ? <p className="membership__error" role="alert">{error}</p> : null}

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="membership-modal__save"
            disabled={busy || resolved === null || !code.trim()}
            onClick={save}
          >
            {busy ? <Loader2 size={15} className="host-spin" /> : null}
            {editing ? "Save changes" : "Save club ID"}
          </button>
        </div>
      </div>
    </div>
  )
}
