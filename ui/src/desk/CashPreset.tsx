import { useEffect, useMemo, useState } from "react"
import { CircleDollarSign, Loader2, Undo2 } from "lucide-react"
import { deskApi, type UpcomingSession, type Venue } from "./deskApi"
import "./host.css"

const CASH_MEMORY_KEY = "npl.cashSetup.v1"

type CashForm = {
  name: string
  buy_in_price_cents: number
  starting_stack: number
  seats_per_table: number
  topups_enabled: boolean
  rebuy_price_cents: number
  rebuy_chips: number
  jackpot_enabled: boolean
  jackpot_price_cents: number
  // Time cut-offs: minutes after Start game. 0 = open until finished.
  cash_reg_close_min: number
  cash_jackpot_close_min: number
}

const DEFAULTS: CashForm = {
  name: "",
  buy_in_price_cents: 10000,
  starting_stack: 10000,
  seats_per_table: 8,
  topups_enabled: true,
  rebuy_price_cents: 10000,
  rebuy_chips: 10000,
  jackpot_enabled: false,
  jackpot_price_cents: 500,
  cash_reg_close_min: 0,
  cash_jackpot_close_min: 0,
}

function remembered(): CashForm | null {
  try {
    const raw = window.localStorage.getItem(CASH_MEMORY_KEY)
    if (!raw) return null
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CashForm>), name: "" }
  } catch {
    return null
  }
}

type Props = {
  venue: Venue | null
  onOpened: (sessionId: number) => void
  onBack: () => void
  initialLinkedSessionId?: number | null
  editSessionId?: number | null
}

/**
 * Cash game preparation — the tournament preset with everything a cash game
 * doesn't have taken away: no blind ladder, no clock, no cut-offs, no
 * add-ons. Buy-in and top-ups stay open until the game is finished.
 */
export default function CashPreset({ venue, onOpened, onBack, initialLinkedSessionId = null, editSessionId = null }: Props) {
  const [form, setForm] = useState<CashForm>(() => remembered() ?? DEFAULTS)
  const [sessions, setSessions] = useState<UpcomingSession[]>([])
  const [linkedSessionId, setLinkedSessionId] = useState<number | "">(initialLinkedSessionId ?? "")
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [loadingEdit, setLoadingEdit] = useState(editSessionId !== null)

  const defaultName = useMemo(() => {
    const today = new Date().toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    return `${today} — ${venue?.name ?? "NPL Cash Game"}`
  }, [venue])

  useEffect(() => {
    if (!venue) return
    deskApi.upcomingSessions(venue.id)
      .then((result) => {
        const cash = result.sessions.filter((session) => session.category === "cash_game")
        setSessions(cash)
        // Auto-link tonight's cash session when nothing was chosen yet.
        setLinkedSessionId((current) => (current === "" && initialLinkedSessionId === null && cash[0] && editSessionId === null
          ? cash[0].session_id
          : current))
      })
      .catch(() => setSessions([]))
  }, [venue, initialLinkedSessionId, editSessionId])

  useEffect(() => {
    if (editSessionId === null) return
    deskApi.tournament(editSessionId)
      .then(({ session }) => {
        const s = session as Record<string, unknown>
        setForm({
          name: (s.name as string) ?? "",
          buy_in_price_cents: (s.buy_in_price_cents as number) ?? 0,
          starting_stack: (s.starting_stack as number) ?? 0,
          seats_per_table: (s.seats_per_table as number) ?? 8,
          topups_enabled: ((s.max_rebuys_per_player as number) ?? 0) > 0,
          rebuy_price_cents: (s.rebuy_price_cents as number) ?? 0,
          rebuy_chips: (s.rebuy_chips as number) ?? 0,
          jackpot_enabled: Boolean(s.jackpot_enabled),
          jackpot_price_cents: (s.jackpot_price_cents as number) ?? 0,
          cash_reg_close_min: (s.cash_reg_close_min as number) ?? 0,
          cash_jackpot_close_min: (s.cash_jackpot_close_min as number) ?? 0,
        })
        setLinkedSessionId((s.game_session_id as number | null) ?? "")
      })
      .catch((e) => setError(e instanceof Error ? e.message : "The draft could not be loaded."))
      .finally(() => setLoadingEdit(false))
  }, [editSessionId])

  function set<K extends keyof CashForm>(key: K, value: CashForm[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function open() {
    if (opening) return
    setOpening(true)
    setError(null)

    const payload = {
      game_type: "cash",
      name: form.name.trim() || defaultName,
      game_session_id: linkedSessionId === "" ? null : linkedSessionId,
      buy_in_price_cents: form.buy_in_price_cents,
      starting_stack: Math.max(1, form.starting_stack),
      seats_per_table: form.seats_per_table,
      rebuy_price_cents: form.topups_enabled ? form.rebuy_price_cents : 0,
      rebuy_chips: form.topups_enabled ? form.rebuy_chips : 0,
      rebuy_tiers: form.topups_enabled ? [{ price_cents: form.rebuy_price_cents, chips: form.rebuy_chips }] : [],
      max_rebuys_per_player: form.topups_enabled ? 255 : 0,
      addon_chips: 0,
      addon_price_cents: 0,
      max_addons_per_player: 0,
      jackpot_enabled: form.jackpot_enabled,
      jackpot_price_cents: form.jackpot_price_cents,
      cash_reg_close_min: form.cash_reg_close_min > 0 ? form.cash_reg_close_min : null,
      cash_jackpot_close_min: form.cash_jackpot_close_min > 0 ? form.cash_jackpot_close_min : null,
      venue_id: venue?.id ?? null,
      venue_name: venue?.name ?? null,
    }

    try {
      if (editSessionId !== null) {
        await deskApi.updateTournament(editSessionId, payload)
        onOpened(editSessionId)
        return
      }

      const created = await deskApi.createTournament(payload)

      try {
        window.localStorage.setItem(CASH_MEMORY_KEY, JSON.stringify({ ...form, name: "" }))
      } catch {
        // Storage blocked — not worth failing the open.
      }

      onOpened(created.session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The cash game could not be opened.")
    } finally {
      setOpening(false)
    }
  }

  const dollars = (cents: number) => (cents / 100).toFixed(0)

  return (
    <div className="cashprep">
      <header className="cashprep__head">
        <div>
          <h3><CircleDollarSign size={18} /> Cash game — preparation</h3>
          <p>No clock, no blind ladder, no cut-offs: buy-ins and top-ups stay open until the game is finished. Vouchers never apply to cash games.</p>
        </div>
        <button type="button" className="host-desk__exit" onClick={onBack}><Undo2 size={14} /> Back</button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}

      {loadingEdit ? (
        <p className="players__empty"><Loader2 size={15} className="host-spin" /> Loading the draft…</p>
      ) : (
        <div className="cashprep__card">
          <div className="cashprep__grid">
            <label className="cashprep__wide">
              <span>Game name</span>
              <input value={form.name} onChange={(event) => set("name", event.target.value)} placeholder={defaultName} />
            </label>

            <label className="cashprep__wide">
              <span>Linked online session</span>
              <select
                value={linkedSessionId === "" ? "" : String(linkedSessionId)}
                onChange={(event) => setLinkedSessionId(event.target.value === "" ? "" : Number(event.target.value))}
              >
                <option value="">Not linked — local-only cash game</option>
                {sessions.map((session) => (
                  <option key={session.session_id} value={session.session_id}>
                    {session.session_date}{session.start_time ? ` ${session.start_time.slice(0, 5)}` : ""} — {session.title ?? `Session #${session.session_id}`} ({session.registrations_count} registered)
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Buy-in ($)</span>
              <input
                type="number" min={0}
                value={dollars(form.buy_in_price_cents)}
                onChange={(event) => set("buy_in_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
              />
            </label>
            <label>
              <span>Chips handed</span>
              <input
                type="number" min={1}
                value={form.starting_stack}
                onChange={(event) => set("starting_stack", Math.max(1, Number(event.target.value) || 1))}
              />
            </label>
            <label>
              <span>Seats per table</span>
              <input
                type="number" min={2} max={10}
                value={form.seats_per_table}
                onChange={(event) => set("seats_per_table", Math.min(10, Math.max(2, Number(event.target.value) || 8)))}
              />
            </label>

            <label className="cashprep__toggle">
              <input
                type="checkbox"
                checked={form.topups_enabled}
                onChange={(event) => set("topups_enabled", event.target.checked)}
              />
              <span>Top-ups allowed (rebuy)</span>
            </label>
            {form.topups_enabled ? (
              <>
                <label>
                  <span>Top-up ($)</span>
                  <input
                    type="number" min={0}
                    value={dollars(form.rebuy_price_cents)}
                    onChange={(event) => set("rebuy_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
                  />
                </label>
                <label>
                  <span>Top-up chips</span>
                  <input
                    type="number" min={1}
                    value={form.rebuy_chips}
                    onChange={(event) => set("rebuy_chips", Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
              </>
            ) : null}

            <label className="cashprep__toggle">
              <input
                type="checkbox"
                checked={form.jackpot_enabled}
                onChange={(event) => set("jackpot_enabled", event.target.checked)}
              />
              <span>Jackpot side pool</span>
            </label>
            {form.jackpot_enabled ? (
              <label>
                <span>Jackpot entry ($)</span>
                <input
                  type="number" min={0}
                  value={dollars(form.jackpot_price_cents)}
                  onChange={(event) => set("jackpot_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
                />
              </label>
            ) : null}

            <label>
              <span>Registration closes (min after start, 0 = never)</span>
              <input
                type="number" min={0} max={1440}
                value={form.cash_reg_close_min}
                onChange={(event) => set("cash_reg_close_min", Math.max(0, Math.min(1440, Number(event.target.value) || 0)))}
              />
            </label>
            {form.jackpot_enabled ? (
              <label>
                <span>Jackpot closes (min after start, 0 = never)</span>
                <input
                  type="number" min={0} max={1440}
                  value={form.cash_jackpot_close_min}
                  onChange={(event) => set("cash_jackpot_close_min", Math.max(0, Math.min(1440, Number(event.target.value) || 0)))}
                />
              </label>
            ) : null}
          </div>

          <footer className="cashprep__footer">
            <button type="button" className="cashprep__open" disabled={opening} onClick={() => void open()}>
              {opening ? <Loader2 size={15} className="host-spin" /> : null}
              {editSessionId !== null ? "Save & back to desk" : "Open the cash desk"}
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
