import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import {
  CloudOff, History, IdCard, KeyRound, Loader2, MessageSquarePlus, MessageSquareText,
  Pencil, Search, Ticket, Trash2, UserPlus, Users,
} from "lucide-react"
import type { Venue } from "../desk/deskApi"
import { playersApi, type ActivityResult, type CommentsResult, type DeskVoucher, type RosterPlayer } from "./playersApi"
import { notify } from "../notifications/store"
import "./players.css"

const AUTHOR_KEY = "npl.commentAuthor"

type Action = "edit" | "password" | "comments" | "vouchers" | "activity"

/**
 * Players: search the synced roster and act on a player — edit details,
 * set a password, read/leave staff comments, check and mark vouchers —
 * or register a brand-new member with the same email-code chain the
 * website uses. Every action lands on the cloud directly.
 */
export default function PlayersWorkspace({ venue }: { venue: Venue | null }) {
  const [query, setQuery] = useState("")
  const [players, setPlayers] = useState<RosterPlayer[] | null>(null)
  const [action, setAction] = useState<{ kind: Action, player: RosterPlayer } | null>(null)
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
          <p>Search the roster, then act on a player: edit, password, staff comments, vouchers.</p>
        </div>
        <button type="button" className="players__register" onClick={() => setRegisterOpen(true)}>
          <UserPlus size={15} /> Register player
        </button>
      </header>

      <section className="players__list players__list--full">
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
              <li key={player.npl_id} className="players__row players__row--static">
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
                <span className="players__actions">
                  <button type="button" title="Edit details" onClick={() => setAction({ kind: "edit", player })}>
                    <Pencil size={15} />
                  </button>
                  <button type="button" title="Change password" onClick={() => setAction({ kind: "password", player })}>
                    <KeyRound size={15} />
                  </button>
                  <button type="button" title="Staff comments" onClick={() => setAction({ kind: "comments", player })}>
                    <MessageSquareText size={15} />
                  </button>
                  <button type="button" title="Vouchers" onClick={() => setAction({ kind: "vouchers", player })}>
                    <Ticket size={15} />
                  </button>
                  <button type="button" title="Venue activity" onClick={() => setAction({ kind: "activity", player })}>
                    <History size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {action?.kind === "edit" ? (
        <EditModal player={action.player} onClose={() => setAction(null)} onSaved={() => { setAction(null); runSearch(query) }} />
      ) : null}
      {action?.kind === "password" ? (
        <PasswordModal player={action.player} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "comments" ? (
        <CommentsModal player={action.player} venueId={venueId} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "vouchers" ? (
        <VouchersModal player={action.player} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "activity" ? (
        <ActivityModal player={action.player} onClose={() => setAction(null)} />
      ) : null}

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

// ---------------------------------------------------------------- edit --

function EditModal({ player, onClose, onSaved }: { player: RosterPlayer, onClose: () => void, onSaved: () => void }) {
  const [form, setForm] = useState({
    first_name: "",
    last_name: "",
    preferred_name: "",
    email: "",
    phone: "",
    state_code: "",
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    // Only what was actually typed travels — blank fields stay untouched.
    const changes: Record<string, string> = {}
    for (const [key, value] of Object.entries(form)) {
      if (value.trim() !== "") changes[key] = value.trim()
    }
    if (changes.phone) changes.phone = `+61${changes.phone.replace(/\D/g, "")}`
    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }
    setBusy(true)
    setError(null)
    playersApi.updatePlayer({ npl_id: player.npl_id, ...changes })
      .then(() => {
        notify("system", "Player updated", `${player.display_name} — details saved to the cloud.`, "success")
        onSaved()
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The player could not be updated."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Edit ${player.display_name}`}>
      <form className="membership-modal__card membership-modal__card--wide" onSubmit={submit}>
        <h4><Pencil size={15} /> Edit — {player.display_name} <small className="players__modalsub">{player.npl_id}</small></h4>
        <p>Only the fields you fill in change. Email changes here need no verification code — the desk vouches for the person in front of it.</p>
        <div className="membership-modal__grid">
          <label>
            <span>First name</span>
            <input value={form.first_name} onChange={(event) => set("first_name", event.target.value)} placeholder="Unchanged" />
          </label>
          <label>
            <span>Last name</span>
            <input value={form.last_name} onChange={(event) => set("last_name", event.target.value)} placeholder="Unchanged" />
          </label>
          <label>
            <span>Preferred name</span>
            <input value={form.preferred_name} onChange={(event) => set("preferred_name", event.target.value)} placeholder="Unchanged" />
          </label>
          <label>
            <span>Email (no code needed)</span>
            <input type="email" value={form.email} onChange={(event) => set("email", event.target.value)} placeholder="Unchanged" />
          </label>
          <label>
            <span>Mobile (+61)</span>
            <input
              value={form.phone}
              onChange={(event) => set("phone", event.target.value.replace(/\D/g, "").slice(0, 9))}
              placeholder="Unchanged"
              inputMode="numeric"
            />
          </label>
          <label>
            <span>State</span>
            <select value={form.state_code} onChange={(event) => set("state_code", event.target.value)}>
              <option value="">Unchanged</option>
              {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map((state) => (
                <option key={state} value={state}>{state}</option>
              ))}
            </select>
          </label>
        </div>
        {error ? <p className="players__error" role="alert">{error}</p> : null}
        <div className="membership-modal__actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="membership-modal__save" disabled={busy}>
            {busy ? <Loader2 size={14} className="host-spin" /> : null} Save changes
          </button>
        </div>
      </form>
    </div>
  )
}

// ------------------------------------------------------------ password --

function PasswordModal({ player, onClose }: { player: RosterPlayer, onClose: () => void }) {
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    playersApi.setPassword(player.npl_id, password, confirm)
      .then(() => {
        notify("system", "Password changed", `${player.display_name} can log in with the new password.`, "success")
        onClose()
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The password could not be changed."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Change password — ${player.display_name}`}>
      <form className="membership-modal__card" onSubmit={submit}>
        <h4><KeyRound size={15} /> Change password — {player.display_name}</h4>
        <p>Let the player type it themselves. 10+ characters with upper case, lower case and a number.</p>
        <div className="membership-modal__grid">
          <label>
            <span>New password</span>
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required />
          </label>
          <label>
            <span>Confirm password</span>
            <input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
          </label>
        </div>
        {error ? <p className="players__error" role="alert">{error}</p> : null}
        <div className="membership-modal__actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="membership-modal__save" disabled={busy || !password || !confirm}>
            {busy ? <Loader2 size={14} className="host-spin" /> : null} Set password
          </button>
        </div>
      </form>
    </div>
  )
}

// ------------------------------------------------------------ comments --

function CommentsModal({ player, venueId, onClose }: { player: RosterPlayer, venueId: number | null, onClose: () => void }) {
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
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Staff comments — ${player.display_name}`}>
      <div className="membership-modal__card membership-modal__card--wide players__commentsmodal">
        <h4><MessageSquareText size={15} /> Staff comments — {player.display_name} <small className="players__modalsub">{player.npl_id}</small></h4>

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
            autoFocus
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

        <div className="players__commentsscroll">
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

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ vouchers --

/**
 * The player's venue record: recent finished games from the cloud's book
 * of record — money in, jackpot, and placement where one was recorded.
 */
function ActivityModal({ player, onClose }: { player: RosterPlayer, onClose: () => void }) {
  const [activity, setActivity] = useState<ActivityResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    playersApi.activity(player.npl_id)
      .then(setActivity)
      .catch((e) => setError(e instanceof Error ? e.message : "The activity record could not be loaded."))
  }, [player.npl_id])

  const money = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Venue activity — ${player.display_name}`}>
      <div className="membership-modal__card membership-modal__card--wide players__commentsmodal">
        <h4><History size={15} /> Venue activity — {player.display_name} <small className="players__modalsub">{player.npl_id}</small></h4>

        {error ? <p className="players__error" role="alert">{error}</p> : null}

        {activity ? (
          <p className="players__activitysummary">
            {activity.summary.sessions} finished game{activity.summary.sessions === 1 ? "" : "s"}
            {" · "}{money(activity.summary.total_paid_cents)} paid
            {activity.summary.best_position !== null ? ` · best finish #${activity.summary.best_position}` : ""}
          </p>
        ) : null}

        <div className="players__commentsscroll">
          {activity === null && !error ? (
            <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading from the cloud…</p>
          ) : activity !== null && activity.sessions.length === 0 ? (
            <p className="players__empty">No finished games on record for this player yet.</p>
          ) : activity !== null ? (
            <table className="regs__table">
              <thead>
                <tr><th>Finished</th><th>Game</th><th>Type</th><th>Entries</th><th>Jackpot</th><th>Paid</th><th>Result</th></tr>
              </thead>
              <tbody>
                {activity.sessions.map((session) => (
                  <tr key={session.tournament_uid}>
                    <td>{session.finished_at ? session.finished_at.replace("T", " ").slice(0, 16) : "—"}</td>
                    <td>{session.name}</td>
                    <td>{session.game_type === "cash" ? "Cash" : "Tournament"}</td>
                    <td>
                      {session.buy_ins > 0 ? `Buy-in` : "—"}
                      {session.rebuys > 0 ? ` +${session.rebuys}R` : ""}
                      {session.addons > 0 ? ` +${session.addons}A` : ""}
                    </td>
                    <td>{session.in_jackpot ? "In" : "—"}</td>
                    <td>{money(session.paid_cents)}</td>
                    <td>
                      {session.position !== null
                        ? `#${session.position}${session.field_size !== null ? ` / ${session.field_size}` : ""}${session.points !== null && session.points > 0 ? ` · ${session.points} pts` : ""}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function VouchersModal({ player, onClose }: { player: RosterPlayer, onClose: () => void }) {
  const [vouchers, setVouchers] = useState<DeskVoucher[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [marking, setMarking] = useState<DeskVoucher | null>(null)
  const [handledBy, setHandledBy] = useState(() => window.localStorage.getItem(AUTHOR_KEY) ?? "")
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    playersApi.vouchers(player.npl_id)
      .then((result) => setVouchers(result.vouchers))
      .catch((e) => setError(e instanceof Error ? e.message : "Vouchers could not be loaded."))
  }, [player.npl_id])

  useEffect(() => { load() }, [load])

  function markUsed(voucher: DeskVoucher) {
    if (busy) return
    setBusy(true)
    setError(null)
    window.localStorage.setItem(AUTHOR_KEY, handledBy.trim())
    playersApi.markVoucherUsed(voucher.id, player.npl_id, handledBy.trim() || null)
      .then(() => {
        notify("system", "Voucher marked used", `${voucher.code} — ${player.display_name}${handledBy.trim() ? `, handled by ${handledBy.trim()}` : ""}.`, "success")
        setMarking(null)
        load()
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The voucher could not be marked."))
      .finally(() => setBusy(false))
  }

  return (
    <div className="membership-modal" role="dialog" aria-modal="true" aria-label={`Vouchers — ${player.display_name}`}>
      <div className="membership-modal__card membership-modal__card--wide players__commentsmodal">
        <h4><Ticket size={15} /> Vouchers — {player.display_name} <small className="players__modalsub">{player.npl_id}</small></h4>

        <label className="players__handledby">
          <span>Handled by (recorded on every redemption)</span>
          <input
            value={handledBy}
            onChange={(event) => setHandledBy(event.target.value)}
            placeholder="Your name"
            maxLength={120}
          />
        </label>

        {error ? <p className="players__error" role="alert">{error}</p> : null}

        <div className="players__commentsscroll">
          {vouchers === null ? (
            <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading vouchers…</p>
          ) : vouchers.length === 0 ? (
            <p className="players__empty">This player holds no vouchers.</p>
          ) : (
            <ul className="players__voucherlist">
              {vouchers.map((voucher) => (
                <li key={voucher.id}>
                  <div className="players__voucherrow">
                    <div className="players__voucherinfo">
                      <strong><code>{voucher.code}</code> — {voucher.title || voucher.type}</strong>
                      <small>
                        {voucher.unlimited_uses ? `${voucher.uses_count}/∞ uses` : `${voucher.uses_count}/${voucher.max_uses} uses`}
                        {voucher.expires_at ? ` · until ${voucher.expires_at}` : ""}
                        {" · "}
                        <em className={`players__voucherstatus players__voucherstatus--${voucher.status}`}>{voucher.status}</em>
                      </small>
                      {voucher.last_redemption ? (
                        <small className="players__voucherhandled">
                          Last redeemed {voucher.last_redemption.redeemed_at
                            ? new Date(voucher.last_redemption.redeemed_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })
                            : ""}
                          {voucher.last_redemption.handled_by ? ` — handled by ${voucher.last_redemption.handled_by}` : ""}
                        </small>
                      ) : null}
                    </div>
                    {voucher.status === "active" ? (
                      marking?.id === voucher.id ? (
                        <span className="players__voucherconfirm">
                          <button type="button" disabled={busy} onClick={() => markUsed(voucher)}>
                            {busy ? <Loader2 size={13} className="host-spin" /> : null} Confirm
                          </button>
                          <button type="button" disabled={busy} onClick={() => setMarking(null)}>Cancel</button>
                        </span>
                      ) : (
                        <button type="button" className="players__vouchermark" onClick={() => setMarking(voucher)}>
                          Mark used
                        </button>
                      )
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="membership-modal__actions">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ register --

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
