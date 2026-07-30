import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { CloudOff, IdCard, Loader2, MessageSquarePlus, Search, Trash2, UserPlus, Users } from "lucide-react"
import type { Venue } from "../desk/deskApi"
import { playersApi, type CommentsResult, type RosterPlayer } from "./playersApi"
import { notify } from "../notifications/store"
import "./players.css"

const AUTHOR_KEY = "npl.commentAuthor"

/**
 * Players: search the synced roster, read/leave staff comments (stored on
 * the cloud, venue-attributed) and register a brand-new member with the
 * same email verification-code chain the website uses.
 */
export default function PlayersWorkspace({ venue }: { venue: Venue | null }) {
  const [query, setQuery] = useState("")
  const [players, setPlayers] = useState<RosterPlayer[] | null>(null)
  const [selected, setSelected] = useState<RosterPlayer | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const searchSeq = useRef(0)

  const venueId = venue?.id ?? null

  const runSearch = useCallback((value: string) => {
    const seq = ++searchSeq.current
    playersApi.search(value, venueId)
      .then((result) => {
        if (searchSeq.current === seq) setPlayers(result.players)
      })
      .catch(() => {
        if (searchSeq.current === seq) setPlayers([])
      })
  }, [venueId])

  useEffect(() => {
    const timer = window.setTimeout(() => runSearch(query), 220)
    return () => window.clearTimeout(timer)
  }, [query, runSearch])

  return (
    <div className="players">
      <header className="players__head">
        <div>
          <h3><Users size={18} /> Players{venue ? ` — ${venue.name}` : ""}</h3>
          <p>Search the synced roster, leave staff comments, or register a new member at the desk.</p>
        </div>
        <button type="button" className="players__register" onClick={() => setRegisterOpen(true)}>
          <UserPlus size={15} /> Register player
        </button>
      </header>

      <div className="players__body">
        <section className="players__list">
          <label className="players__search">
            <Search size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, NPL ID or card number…"
              spellCheck={false}
            />
          </label>

          {players === null ? (
            <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading…</p>
          ) : players.length === 0 ? (
            <p className="players__empty">No players match.</p>
          ) : (
            <ul>
              {players.map((player) => (
                <li key={player.npl_id}>
                  <button
                    type="button"
                    className={selected?.npl_id === player.npl_id ? "players__row players__row--active" : "players__row"}
                    onClick={() => setSelected(player)}
                  >
                    {player.avatar_media_key
                      ? <img src={`/media/${player.avatar_media_key}`} alt="" />
                      : <span className="players__initials">{player.display_name.slice(0, 2).toUpperCase()}</span>}
                    <span className="players__who">
                      <strong>
                        {venueId !== null && player.club_member_code === null ? (
                          <span className="club-flag" title="No club membership ID" />
                        ) : null}
                        {player.display_name}
                      </strong>
                      <small>
                        {player.npl_id}
                        {player.public_player_code ? ` · ${player.public_player_code}` : ""}
                        {player.state_code ? ` · ${player.state_code}` : ""}
                      </small>
                    </span>
                    {player.club_member_code ? (
                      <span className="players__clubchip" title="Club membership ID">
                        <IdCard size={12} /> {player.club_member_code}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="players__detail">
          {selected === null ? (
            <p className="players__empty">Pick a player to read and leave staff comments.</p>
          ) : (
            <PlayerComments key={selected.npl_id} player={selected} venueId={venueId} />
          )}
        </section>
      </div>

      {registerOpen ? (
        <RegisterWizard
          onClose={() => setRegisterOpen(false)}
          onRegistered={(nplId) => {
            setRegisterOpen(false)
            setQuery(nplId)
          }}
        />
      ) : null}
    </div>
  )
}

function PlayerComments({ player, venueId }: { player: RosterPlayer, venueId: number | null }) {
  const [result, setResult] = useState<CommentsResult | null>(null)
  const [note, setNote] = useState("")
  const [author, setAuthor] = useState(() => window.localStorage.getItem(AUTHOR_KEY) ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    playersApi.comments(player.npl_id)
      .then(setResult)
      .catch(() => setResult({ available: false, comments: [], truncated: false }))
  }, [player.npl_id])

  useEffect(() => { load() }, [load])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!note.trim() || busy) return
    setBusy(true)
    setError(null)
    window.localStorage.setItem(AUTHOR_KEY, author.trim())
    playersApi.addComment(player.npl_id, note.trim(), author.trim() || null, venueId)
      .then(() => {
        setNote("")
        notify("system", "Comment saved", `${player.display_name} — note on the cloud record.`, "success")
        load()
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The comment could not be saved."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="players-comments">
      <header>
        <strong>{player.display_name}</strong>
        <small>{player.npl_id}{player.public_player_code ? ` · ${player.public_player_code}` : ""}</small>
      </header>

      {result?.available === false ? (
        <p className="players__offline"><CloudOff size={13} /> Cloud unreachable — comments unavailable right now.</p>
      ) : null}

      <form className="players-comments__composer" onSubmit={submit}>
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={`Leave a staff comment on ${player.display_name}…`}
          rows={3}
          maxLength={5000}
        />
        <div className="players-comments__composerrow">
          <input
            value={author}
            onChange={(event) => setAuthor(event.target.value)}
            placeholder="Your name (optional)"
            maxLength={120}
          />
          <button type="submit" disabled={busy || !note.trim() || result?.available === false}>
            {busy ? <Loader2 size={14} className="host-spin" /> : <MessageSquarePlus size={14} />} Save comment
          </button>
        </div>
        {error ? <p className="players__error" role="alert">{error}</p> : null}
      </form>

      {result === null ? (
        <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading comments…</p>
      ) : result.comments.length === 0 ? (
        result.available ? <p className="players__empty">No staff comments yet.</p> : null
      ) : (
        <ul className="players-comments__list">
          {result.truncated ? <li className="players-comments__truncated">Showing the latest 50.</li> : null}
          {result.comments.map((comment) => (
            <li key={comment.id}>
              <div className="players-comments__meta">
                <strong>{comment.author_name}</strong>
                <span>
                  {comment.venue_name ? `${comment.venue_name} · ` : ""}
                  {new Date(comment.created_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}
                </span>
                <button
                  type="button"
                  title="Delete comment"
                  onClick={() => {
                    playersApi.deleteComment(comment.id)
                      .then(load)
                      .catch((e) => notify("system", "Comment not removed", e instanceof Error ? e.message : "Try again.", "warning"))
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <p>{comment.note}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"] as const

function RegisterWizard({ onClose, onRegistered }: {
  onClose: () => void
  onRegistered: (nplId: string) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState("")
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    preferred_name: "",
    npl_id: "",
    phone: "",
    state_code: "NSW",
    username: "",
    password: "",
    password_confirmation: "",
    verification_code: "",
  })
  const [done, setDone] = useState<{ npl_id: string, public_player_code: string, display_name: string } | null>(null)

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    setError(null)
    playersApi.registerCode(email.trim().toLowerCase())
      .then(() => setStep(2))
      .catch((e) => setError(e instanceof Error ? e.message : "The code could not be sent."))
      .finally(() => setBusy(false))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    playersApi.register({
      ...form,
      email: email.trim().toLowerCase(),
      phone: `+61${form.phone.replace(/\D/g, "")}`,
    })
      .then((result) => {
        const player = result.result.player
        setDone(player)
        notify("system", "Member registered", `${player.display_name} — ${player.npl_id} · card ${player.public_player_code}`, "success")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Registration failed."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label="Register player">
      <div className="membership-modal__card membership-modal__card--wide">
        {done ? (
          <>
            <h4>Member registered 🎉</h4>
            <p>
              <strong>{done.display_name}</strong> is on the NPL roster — NPL ID <strong>{done.npl_id}</strong>,
              member card <strong>{done.public_player_code}</strong>. They can log in on the website with the
              username and password they just set.
            </p>
            <div className="membership-modal__actions">
              <button type="button" className="membership-modal__save" onClick={() => onRegistered(done.npl_id)}>Done</button>
            </div>
          </>
        ) : step === 1 ? (
          <form onSubmit={sendCode}>
            <h4>Register player — step 1 of 2</h4>
            <p>The player's email gets a 6-digit verification code, exactly like registering on the website. They read it back to you.</p>
            <div className="membership-modal__grid">
              <label className="membership-modal__notes">
                <span>Player's email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="player@email.com"
                  autoFocus
                  required
                />
              </label>
            </div>
            {error ? <p className="players__error" role="alert">{error}</p> : null}
            <div className="membership-modal__actions">
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="membership-modal__save" disabled={busy || !email.trim()}>
                {busy ? <Loader2 size={14} className="host-spin" /> : null} Email the code
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={submit}>
            <h4>Register player — step 2 of 2</h4>
            <p>Code sent to <strong>{email}</strong>. Fill in their details; the player types their own password.</p>
            <div className="membership-modal__grid">
              <label>
                <span>Verification code</span>
                <input
                  value={form.verification_code}
                  onChange={(event) => set("verification_code", event.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="6 digits from their email"
                  inputMode="numeric"
                  autoFocus
                  required
                />
              </label>
              <label>
                <span>NPL ID (their choice)</span>
                <input value={form.npl_id} onChange={(event) => set("npl_id", event.target.value)} placeholder="e.g. KyleC2026" required />
              </label>
              <label>
                <span>First name</span>
                <input value={form.first_name} onChange={(event) => set("first_name", event.target.value)} required />
              </label>
              <label>
                <span>Last name</span>
                <input value={form.last_name} onChange={(event) => set("last_name", event.target.value)} required />
              </label>
              <label>
                <span>Preferred name</span>
                <input value={form.preferred_name} onChange={(event) => set("preferred_name", event.target.value)} required />
              </label>
              <label>
                <span>Mobile (+61)</span>
                <input
                  value={form.phone}
                  onChange={(event) => set("phone", event.target.value.replace(/\D/g, "").slice(0, 9))}
                  placeholder="4XX XXX XXX"
                  inputMode="numeric"
                  required
                />
              </label>
              <label>
                <span>State</span>
                <select value={form.state_code} onChange={(event) => set("state_code", event.target.value)}>
                  {STATES.map((state) => <option key={state} value={state}>{state}</option>)}
                </select>
              </label>
              <label>
                <span>Username (for login)</span>
                <input value={form.username} onChange={(event) => set("username", event.target.value.toLowerCase())} required />
              </label>
              <label>
                <span>Password (player types it)</span>
                <input type="password" value={form.password} onChange={(event) => set("password", event.target.value)} required />
              </label>
              <label>
                <span>Confirm password</span>
                <input type="password" value={form.password_confirmation} onChange={(event) => set("password_confirmation", event.target.value)} required />
              </label>
            </div>
            <p className="players__hint">Password: 10+ characters with upper case, lower case and a number.</p>
            {error ? <p className="players__error" role="alert">{error}</p> : null}
            <div className="membership-modal__actions">
              <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" onClick={() => { setStep(1); setError(null) }} disabled={busy}>Back</button>
              <button type="submit" className="membership-modal__save" disabled={busy}>
                {busy ? <Loader2 size={14} className="host-spin" /> : null} Register member
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
