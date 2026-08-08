import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { deskApi, money, type ActiveSession, type AddonTier, type GeneratedLevel, type UpcomingSession, type Venue } from "./deskApi"
import "./preparation.css"

export type CutOffKind = "registration" | "rebuy" | "addon" | "jackpot"

export const CUT_OFF_META: Record<CutOffKind, { label: string, short: string }> = {
  registration: { label: "Registration", short: "REG" },
  rebuy: { label: "Rebuys", short: "RE" },
  addon: { label: "Add-ons", short: "ADD" },
  jackpot: { label: "Jackpot", short: "JP" },
}

type Props = {
  venue: Venue | null
  onOpened: (sessionId: number) => void
  /** Cloud session chosen on the Sessions hub — pre-links the tournament. */
  initialLinkedSessionId?: number | null
  /** Back to the Sessions hub. */
  onBack?: () => void
  /**
   * Re-open the prep screen for an existing DRAFT tournament: settings
   * load in, and saving updates in place instead of creating. Available
   * right up until Start is pressed.
   */
  editSessionId?: number | null
}

type Optional = number | ""

const DEFAULTS = {
  name: "",
  seats_per_table: 8,
  starting_stack: 20000,
  buy_in_price_cents: 10000,
  rebuy_tiers: [{ price_cents: 10000, chips: 20000 }] as AddonTier[],
  max_rebuys_per_player: 0,
  addon_tiers: [{ price_cents: 5000, chips: 30000 }] as AddonTier[],
  max_addons_per_player: 1,
  jackpot_enabled: true,
  jackpot_price_cents: 1000,
  // Room-display extras: what the big clock's side panel shows.
  chip_denominations: "",
}

// Last night's setup is next night's starting point — venues run the same
// game week after week, so the form remembers itself across restarts and
// across venues. The name is not remembered: it defaults to date + venue.
const SETUP_MEMORY_KEY = "npl.tournamentSetup.v1"

function rememberedSetup(): { form: typeof DEFAULTS, pattern: typeof PATTERN, cutOffs: Record<CutOffKind, Optional> } | null {
  try {
    const raw = window.localStorage.getItem(SETUP_MEMORY_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as { form?: Partial<typeof DEFAULTS>, pattern?: Partial<typeof PATTERN>, cutOffs?: Partial<Record<CutOffKind, Optional>> }

    return {
      form: { ...DEFAULTS, ...stored.form, name: "" },
      pattern: { ...PATTERN, ...stored.pattern },
      cutOffs: { registration: 6, rebuy: "", addon: "", jackpot: "", ...stored.cutOffs },
    }
  } catch {
    return null
  }
}

const PATTERN = {
  levels: 18,
  duration_min: 20,
  small_blind: 100,
  big_blind_multiple: 2,
  mode: "multiply" as "multiply" | "add",
  step: 1.5,
  break_every: 6,
  break_duration_min: 15,
  ante_from_level: 5 as Optional,
  ante_as_big_blind: true,
}

const STEPS: { id: "prepare" | "host" | "play" | "finish", label: string }[] = [
  { id: "prepare", label: "Preparation" },
  { id: "host", label: "Host" },
  { id: "play", label: "Playing" },
  { id: "finish", label: "Finishing" },
]

/**
 * The screen the operator fills in before the doors open.
 *
 * The layout is EdgeHost's Sichuan Preparation page, deliberately: stepper,
 * progress bar, title row with chips, summary strip, stacked cards, and the
 * blind table in the same five-column shape. What poker adds on top of
 * Sichuan is the cut-off system — it lives behind the extra "Cut-off" button
 * on the Blind Structure card, since Sichuan has no such concept.
 *
 * Everything that costs money and every cut-off is decided here, because
 * changing the price of a rebuy once players are in the room is not a
 * conversation anyone wants to have.
 */
export default function HostPreset({ venue, onOpened, initialLinkedSessionId = null, onBack, editSessionId = null }: Props) {
  const remembered = useMemo(rememberedSetup, [])
  const [form, setForm] = useState(remembered?.form ?? DEFAULTS)
  const [pattern, setPattern] = useState(remembered?.pattern ?? PATTERN)
  const [levels, setLevels] = useState<GeneratedLevel[]>([])
  const [cutOffs, setCutOffs] = useState<Record<CutOffKind, Optional>>(remembered?.cutOffs ?? {
    registration: 6,
    rebuy: "",
    addon: "",
    jackpot: "",
  })
  const [cutOffsOpen, setCutOffsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)

  // One session at a time: if the room already has an unfinished session
  // (and it is not the draft being edited here), saving asks the operator
  // to confirm erasing it — say so up front, not only at the button press.
  const [blocking, setBlocking] = useState<ActiveSession | null>(null)
  // The blocker the operator is being asked to erase — set from a FRESH
  // active-session read at the moment Save is pressed, never the mount-time
  // snapshot, so the dialog always names what would actually be erased.
  const [confirmReplace, setConfirmReplace] = useState<ActiveSession | null>(null)

  useEffect(() => {
    deskApi.activeSession()
      .then((active) => setBlocking(active && active.id !== editSessionId ? active : null))
      .catch(() => setBlocking(null))
  }, [editSessionId])

  const discardBlocking = async () => {
    if (!blocking) return
    try {
      await deskApi.discardTournament(blocking.id)
      setBlocking(null)
      setError(null)
      window.dispatchEvent(new CustomEvent("npl:desk-session-changed"))
    } catch (e) {
      setError(e instanceof Error ? e.message : "The draft could not be discarded.")
    }
  }

  // Once a level has been touched by hand the pattern stops driving the
  // ladder — silently overwriting someone's tuned structure would be the
  // worst thing this screen could do.
  const [handEdited, setHandEdited] = useState(false)
  const loadedOnce = useRef(false)

  // Linking to tonight's cloud session is what turns on the live layer:
  // online bookings on scan, cloud-managed tables, instant public seat
  // maps. Auto-picked when exactly one non-cash session runs today.
  const [cloudSessions, setCloudSessions] = useState<UpcomingSession[]>([])
  const [linkedSessionId, setLinkedSessionId] = useState<number | "">("")

  useEffect(() => {
    if (!venue) {
      setCloudSessions([])
      setLinkedSessionId("")
      return
    }

    let cancelled = false
    void deskApi.upcomingSessions(venue.id)
      .then((result) => {
        if (cancelled) return
        const tournaments = result.sessions.filter((session) => session.category !== "cash_game")
        setCloudSessions(tournaments)

        // A hub choice wins; otherwise auto-pick the single session today.
        if (initialLinkedSessionId !== null && tournaments.some((s) => s.session_id === initialLinkedSessionId)) {
          setLinkedSessionId(initialLinkedSessionId)
        } else {
          const today = new Date().toISOString().slice(0, 10)
          const tonight = tournaments.filter((session) => session.session_date === today)
          setLinkedSessionId(tonight.length === 1 ? tonight[0].session_id : "")
        }
      })
      .catch(() => {
        if (!cancelled) setCloudSessions([])
      })

    return () => {
      cancelled = true
    }
  }, [venue, initialLinkedSessionId])

  const progressPercent = ((currentStepIndex + 1) / STEPS.length) * 100

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const updatePattern = <K extends keyof typeof pattern>(key: K, value: (typeof pattern)[K]) =>
    setPattern((current) => ({ ...current, [key]: value }))

  const generate = useCallback(async () => {
    setGenerating(true)
    setError(null)

    try {
      const result = await deskApi.previewStructure({
        ...pattern,
        ante_from_level: pattern.ante_from_level === "" ? null : pattern.ante_from_level,
      })
      setLevels(result.levels)
      setHandEdited(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The structure could not be generated.")
    } finally {
      setGenerating(false)
    }
  }, [pattern])

  // Fill the ladder once on arrival so the screen is never empty; after that
  // generating is an explicit act. In edit mode the existing tournament
  // loads instead — settings, tiers, cut-offs and the tuned ladder.
  useEffect(() => {
    if (loadedOnce.current) return
    loadedOnce.current = true

    if (editSessionId === null) {
      void generate()
      return
    }

    void deskApi.tournament(editSessionId)
      .then((result) => {
        const s = result.session as Record<string, unknown>
        setForm((current) => ({
          ...current,
          name: (s.name as string) ?? "",
          seats_per_table: (s.seats_per_table as number) ?? current.seats_per_table,
          starting_stack: (s.starting_stack as number) ?? current.starting_stack,
          buy_in_price_cents: (s.buy_in_price_cents as number) ?? current.buy_in_price_cents,
          rebuy_tiers: Array.isArray(s.rebuy_tiers) && s.rebuy_tiers.length ? s.rebuy_tiers as AddonTier[] : current.rebuy_tiers,
          max_rebuys_per_player: (s.max_rebuys_per_player as number) ?? current.max_rebuys_per_player,
          addon_tiers: Array.isArray(s.addon_tiers) && s.addon_tiers.length ? s.addon_tiers as AddonTier[] : current.addon_tiers,
          max_addons_per_player: (s.max_addons_per_player as number) ?? current.max_addons_per_player,
          jackpot_enabled: (s.jackpot_enabled as boolean) ?? current.jackpot_enabled,
          jackpot_price_cents: (s.jackpot_price_cents as number) ?? current.jackpot_price_cents,
          chip_denominations: (((s.settings as Record<string, unknown> | null)?.chip_denominations as string | undefined) ?? current.chip_denominations),
        }))
        setCutOffs({
          registration: (s.registration_closes_at_level as number | null) ?? "",
          rebuy: (s.rebuy_closes_at_level as number | null) ?? "",
          addon: (s.addon_closes_at_level as number | null) ?? "",
          jackpot: (s.jackpot_closes_at_level as number | null) ?? "",
        })
        setLinkedSessionId((s.game_session_id as number | null) ?? "")
        setLevels(result.levels)
        setHandEdited(true)
      })
      .catch(() => {
        setError("The tournament settings could not be loaded — showing defaults.")
        void generate()
      })
  }, [generate, editSessionId])

  const numericCutOffs = useMemo(() => ({
    registration: cutOffs.registration === "" ? undefined : Number(cutOffs.registration),
    rebuy: cutOffs.rebuy === "" ? undefined : Number(cutOffs.rebuy),
    addon: cutOffs.addon === "" ? undefined : Number(cutOffs.addon),
    jackpot: cutOffs.jackpot === "" ? undefined : Number(cutOffs.jackpot),
  }), [cutOffs])

  /** Minutes of play before a given ladder position begins. */
  function minutesBefore(position: number): number {
    return levels.slice(0, Math.max(0, position - 1)).reduce((sum, row) => sum + row.duration_min, 0)
  }

  function describeCutOff(kind: CutOffKind): string {
    const position = numericCutOffs[kind]
    if (!position) return "No cut-off — open until the game finishes"

    const row = levels[position - 1]
    if (!row) return `Row ${position}`

    const label = row.type === "break"
      ? (row.note || "Break")
      : `${row.small_blind.toLocaleString()} / ${row.big_blind.toLocaleString()}`

    return `${label} · ${minutesBefore(position)} min in`
  }

  /**
   * Level numbers are derived, never typed: blinds count up, and a break
   * carries the number of the level before it, so "registration closes at
   * level 6" keeps meaning the same thing however the ladder is edited.
   */
  function renumber(rows: GeneratedLevel[]): GeneratedLevel[] {
    let levelNo = 0

    return rows.map((row, index) => {
      if (row.type === "blind") levelNo += 1

      return { ...row, level_no: levelNo || 1, sort_order: index + 1 }
    })
  }

  function patch(index: number, changes: Partial<GeneratedLevel>) {
    setLevels(renumber(levels.map((row, i) => (i === index ? { ...row, ...changes } : row))))
    setHandEdited(true)
  }

  function changeType(index: number, type: "blind" | "break") {
    const previous = levels[index - 1]

    if (type === "break") {
      patch(index, { type, small_blind: 0, big_blind: 0, ante: 0, bb_ante: 0, note: "Break" })
      return
    }

    patch(index, {
      type,
      small_blind: previous && previous.type === "blind" ? Math.max(1, previous.small_blind * 2) : 100,
      big_blind: previous && previous.type === "blind" ? Math.max(2, previous.big_blind * 2) : 200,
      ante: 0,
      bb_ante: previous?.bb_ante ? previous.bb_ante * 2 : 0,
      note: null,
    })
  }

  function addLevel() {
    const lastBlind = levels.filter((row) => row.type === "blind").slice(-1)[0]
    const row: GeneratedLevel = {
      level_no: 0,
      type: "blind",
      // A new level opens where the previous one left off, doubled — a
      // sensible guess that is immediately editable.
      small_blind: lastBlind ? Math.max(1, lastBlind.small_blind * 2) : 100,
      big_blind: lastBlind ? Math.max(2, lastBlind.big_blind * 2) : 200,
      ante: 0,
      bb_ante: lastBlind?.bb_ante ? lastBlind.bb_ante * 2 : 0,
      duration_min: lastBlind?.duration_min ?? pattern.duration_min,
      sort_order: 0,
      note: null,
    }

    setLevels(renumber([...levels, row]))
    setHandEdited(true)
  }

  function removeLevel(index: number) {
    setLevels(renumber(levels.filter((_, i) => i !== index)))
    setHandEdited(true)
  }

  const defaultName = useMemo(() => {
    const date = new Date().toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    return venue?.name ? `${date} — ${venue.name}` : date
  }, [venue?.name])

  async function open(replaceSessionId?: number) {
    setError(null)

    if (cutOffs.registration === "") {
      setCutOffsOpen(true)
      setError("Set the level registration closes at — everything else hangs off it.")
      return
    }

    // Creating over an unfinished session erases it — that needs a fresh
    // look (not the mount-time snapshot) and the operator's explicit yes.
    if (editSessionId === null && replaceSessionId === undefined) {
      const active = await deskApi.activeSession().catch(() => null)
      const fresh = active && active.id !== editSessionId ? active : null
      setBlocking(fresh)

      if (fresh) {
        setConfirmReplace(fresh)
        return
      }
    }

    setOpening(true)

    try {
      const optional = (value: Optional) => (value === "" ? null : Number(value))
      const tiers = form.addon_tiers.filter((tier) => tier.chips > 0)
      const rebuyTiers = form.rebuy_tiers.filter((tier) => tier.chips > 0)

      // Editing a draft saves in place; a new night creates.
      if (editSessionId !== null) {
        await deskApi.updateTournament(editSessionId, {
          name: form.name.trim() || defaultName,
          game_session_id: linkedSessionId === "" ? null : linkedSessionId,
          starting_stack: form.starting_stack,
          buy_in_price_cents: form.buy_in_price_cents,
          seats_per_table: form.seats_per_table,
          jackpot_enabled: form.jackpot_enabled,
          jackpot_price_cents: form.jackpot_price_cents,
          max_rebuys_per_player: form.max_rebuys_per_player,
          max_addons_per_player: form.max_addons_per_player,
          addon_tiers: tiers,
          rebuy_tiers: rebuyTiers,
          registration_closes_at_level: Number(cutOffs.registration),
          rebuy_closes_at_level: optional(cutOffs.rebuy),
          addon_closes_at_level: optional(cutOffs.addon),
          jackpot_closes_at_level: optional(cutOffs.jackpot),
          venue_id: venue?.id ?? null,
          settings: {
            chip_denominations: form.chip_denominations.trim(),

          },
          levels,
        })

        onOpened(editSessionId)
        return
      }

      const created = await deskApi.createTournament({
        ...form,
        ...(replaceSessionId !== undefined ? { replace_session_id: replaceSessionId } : {}),
        name: form.name.trim() || defaultName,
        game_session_id: linkedSessionId === "" ? null : linkedSessionId,
        addon_tiers: tiers,
        rebuy_tiers: rebuyTiers,
        // Legacy pairs mirror tier one for older readers of the session.
        addon_price_cents: tiers[0]?.price_cents ?? 0,
        addon_chips: tiers[0]?.chips ?? 0,
        rebuy_price_cents: rebuyTiers[0]?.price_cents ?? 0,
        rebuy_chips: rebuyTiers[0]?.chips ?? 0,
        venue_id: venue?.id ?? null,
        venue_name: venue?.name ?? null,
        registration_closes_at_level: Number(cutOffs.registration),
        rebuy_closes_at_level: optional(cutOffs.rebuy),
        addon_closes_at_level: optional(cutOffs.addon),
        jackpot_closes_at_level: optional(cutOffs.jackpot),
        settings: {
          chip_denominations: form.chip_denominations.trim(),

        },
        levels,
      })

      // Tonight's setup becomes next time's starting point.
      try {
        window.localStorage.setItem(SETUP_MEMORY_KEY, JSON.stringify({ form: { ...form, name: "" }, pattern, cutOffs }))
      } catch {
        // Storage full/blocked: not worth failing the open.
      }

      // The sidebar admin QR appears the moment the session exists.
      setBlocking(null)
      window.dispatchEvent(new CustomEvent("npl:desk-session-changed"))
      onOpened(created.session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The session could not be opened.")
      // The refusal may mean the open session changed — re-look so the
      // banner (and the next confirm) names the real blocker.
      deskApi.activeSession()
        .then((active) => setBlocking(active && active.id !== editSessionId ? active : null))
        .catch(() => {})
    } finally {
      setOpening(false)
    }
  }

  const handleStepClick = (id: "prepare" | "host" | "play" | "finish") => {
    if (id === "prepare") {
      setCurrentStepIndex(0)
      return
    }
    if (id === "host") {
      setCurrentStepIndex(1)
      void open()
      return
    }
    // Playing and Finishing only exist once a session is open — opening it
    // is the Host step's job.
  }

  const totalLevels = useMemo(() => levels.filter((row) => row.type === "blind").length, [levels])
  const hasBreak = useMemo(() => levels.some((row) => row.type === "break"), [levels])
  const totalMinutes = useMemo(() => levels.reduce((sum, row) => sum + row.duration_min, 0), [levels])

  const maxBlind = useMemo(() => {
    const blinds = levels.filter((row) => row.type === "blind").map((row) => row.big_blind)
    if (!blinds.length) return 0
    return Math.max(...blinds)
  }, [levels])

  // Where each cut-off lands, so the operator can see the line in the ladder
  // it actually refers to rather than holding a row number in their head.
  const marks = useMemo(() => {
    const map = new Map<number, CutOffKind[]>()
    for (const [kind, position] of Object.entries(numericCutOffs)) {
      if (!position) continue
      const list = map.get(position) ?? []
      list.push(kind as CutOffKind)
      map.set(position, list)
    }
    return map
  }, [numericCutOffs])

  const maxPosition = Math.max(1, levels.length)

  return (
    <div className="prep">
      <div className="prep__container">
        <div className="prep__top">
          {onBack ? (
            <button type="button" className="prep-back" onClick={onBack}>‹ All sessions</button>
          ) : null}
          <div className="prep-steps">
            {STEPS.map((step, index) => {
              const active = index === currentStepIndex
              const completed = index < currentStepIndex

              return (
                <button
                  key={step.id}
                  type="button"
                  className="prep-steps__item"
                  onClick={() => handleStepClick(step.id)}
                >
                  <div
                    className={[
                      "prep-steps__dot",
                      completed ? "prep-steps__dot--done" : active ? "prep-steps__dot--active" : "",
                    ].filter(Boolean).join(" ")}
                  >
                    {index + 1}
                  </div>
                  <div className="prep-steps__label">{step.label}</div>
                </button>
              )
            })}
          </div>

          <div className="prep-progress">
            <div className="prep-progress__track">
              <div className="prep-progress__fill" style={{ width: `${progressPercent}%` }} />
            </div>
            <div className="prep-progress__meta">
              <span>Preparation</span>
              <span>Step {currentStepIndex + 1} of {STEPS.length}</span>
            </div>
          </div>

          <div className="prep-title">
            <div className="prep-title__left">
              <div className="prep-title__row">
                <div className="prep-title__text">Tournament Preparation</div>
                {venue ? (
                  <span className="prep-chip">
                    Venue
                    <span className="prep-chip__value">{venue.name}</span>
                  </span>
                ) : null}
                <span className="prep-chip prep-chip--status">
                  Status
                  <span className="prep-chip__strong">Idle</span>
                </span>
              </div>
            </div>

            <div className="prep-title__actions">
              <button
                type="button"
                className="prep-btn prep-btn--dark"
                onClick={() => void open()}
                disabled={opening || !venue}
              >
                {opening ? "Saving…" : "Save & Open Host"}
              </button>
            </div>
          </div>
          {venue ? null : <div className="prep-title__hint">Choose a venue in the header to continue.</div>}
        </div>

        <div className="prep-summary">
          <Chip label="Buy-in" value={money(form.buy_in_price_cents)} />
          <Chip label="Stack" value={form.starting_stack.toLocaleString()} />
          <Chip label="Seats" value={String(form.seats_per_table)} />
          <Chip
            label={form.rebuy_tiers.length > 1 ? "Rebuys" : "Rebuy"}
            value={form.rebuy_tiers.length
              ? form.rebuy_tiers.map((tier) => money(tier.price_cents)).join(" / ")
              : "—"}
          />
          <Chip
            label={form.addon_tiers.length > 1 ? "Add-ons" : "Add-on"}
            value={form.addon_tiers.length
              ? form.addon_tiers.map((tier) => money(tier.price_cents)).join(" / ")
              : "—"}
          />
          {form.jackpot_enabled ? <Chip label="Jackpot" value={money(form.jackpot_price_cents)} /> : null}
          <Chip label="Levels" value={`${totalLevels}${hasBreak ? " + Break" : ""}`} />
          <Chip label="Max blind" value={maxBlind ? maxBlind.toLocaleString() : "—"} />
          <Chip label="Length" value={`${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`} />
          <Chip
            label="Reg closes"
            value={numericCutOffs.registration ? `Row ${numericCutOffs.registration}` : "—"}
          />
        </div>

        {blocking ? (
          <div className="prep-error" role="alert">
            “{blocking.name ?? "A session"}” is still open — finish it, or Save &amp; Open Host will ask before
            erasing it.
            {blocking.status === "draft" ? (
              <>
                {" "}
                <button type="button" className="prep-btn prep-btn--dark" onClick={() => void discardBlocking()}>
                  Discard that draft
                </button>
              </>
            ) : null}
          </div>
        ) : null}

        {error ? <div className="prep-error" role="alert">{error}</div> : null}

        <div className="prep-grid">
          <div className="prep-main">
            <section className="prep-card">
              <div className="prep-card__head">
                <div className="prep-card__title">Tournament Settings</div>
              </div>
              <div className="prep-card__body">
                <div className="prep-field">
                  <label>Tournament name (optional)</label>
                  <input
                    type="text"
                    value={form.name}
                    placeholder={defaultName}
                    onChange={(e) => update("name", e.target.value)}
                  />
                  <small>Leave empty to use the date and venue automatically.</small>
                </div>

                <div className="prep-field">
                  <label>Linked online session</label>
                  <select
                    value={linkedSessionId === "" ? "" : String(linkedSessionId)}
                    onChange={(e) => setLinkedSessionId(e.target.value === "" ? "" : Number(e.target.value))}
                  >
                    <option value="">Not linked — local-only tournament</option>
                    {cloudSessions.map((session) => (
                      <option key={session.session_id} value={session.session_id}>
                        {session.session_date}{session.start_time ? ` ${session.start_time.slice(0, 5)}` : ""} — {session.title ?? `Session #${session.session_id}`} ({session.registrations_count} booked)
                      </option>
                    ))}
                  </select>
                  <small>
                    Linking turns on the live layer: online bookings appear on scan, tables come from the
                    cloud with "+ Add table", and seat changes show online instantly.
                  </small>
                </div>

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Buy-in ($)</label>
                    <input
                      type="number" min={0} value={form.buy_in_price_cents / 100}
                      onChange={(e) => update("buy_in_price_cents", Math.round(Number(e.target.value) * 100))}
                    />
                  </div>
                  <div className="prep-field">
                    <label>Starting stack</label>
                    <input
                      type="number" min={1} value={form.starting_stack}
                      onChange={(e) => update("starting_stack", Number(e.target.value))}
                    />
                  </div>
                  <div className="prep-field">
                    <label>Seats per table</label>
                    <input
                      type="number" min={2} max={10} value={form.seats_per_table}
                      onChange={(e) => update("seats_per_table", Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Chip denominations (room clock)</label>
                    <input
                      type="text"
                      value={form.chip_denominations}
                      placeholder="25, 100, 500, 1000, 5000"
                      onChange={(e) => update("chip_denominations", e.target.value)}
                    />
                  </div>
                  {/* No prize input here: the payout ladder comes from the
                      cloud game (Daily Games admin) via Manual Update. */}
                </div>
              </div>
            </section>

            <section className="prep-card">
              <div className="prep-card__head">
                <div className="prep-card__title">Rebuys &amp; Add-ons</div>
              </div>
              <div className="prep-card__body">
                <div className="prep-subhead">Rebuys — up to four tiers, right-click a player for the fast rebuy</div>
                {form.rebuy_tiers.map((tier, index) => (
                  <div className="prep-field-grid prep-tier-row" key={index}>
                    <div className="prep-field">
                      <label>Tier {index + 1} price ($)</label>
                      <input
                        type="number" min={0} value={tier.price_cents / 100}
                        onChange={(e) => update("rebuy_tiers", form.rebuy_tiers.map((row, i) =>
                          i === index ? { ...row, price_cents: Math.round(Number(e.target.value) * 100) } : row))}
                      />
                    </div>
                    <div className="prep-field">
                      <label>Chips</label>
                      <input
                        type="number" min={0} value={tier.chips}
                        onChange={(e) => update("rebuy_tiers", form.rebuy_tiers.map((row, i) =>
                          i === index ? { ...row, chips: Number(e.target.value) } : row))}
                      />
                    </div>
                    <div className="prep-field prep-tier-row__remove">
                      <label>&nbsp;</label>
                      <button
                        type="button"
                        className="prep-tier-remove"
                        disabled={form.rebuy_tiers.length <= 1}
                        onClick={() => update("rebuy_tiers", form.rebuy_tiers.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      className="prep-tier-add"
                      disabled={form.rebuy_tiers.length >= 4}
                      onClick={() => {
                        const last = form.rebuy_tiers[form.rebuy_tiers.length - 1]
                        update("rebuy_tiers", [...form.rebuy_tiers, {
                          price_cents: (last?.price_cents ?? 1000) * 2,
                          chips: (last?.chips ?? 20000) * 2,
                        }])
                      }}
                    >
                      + Add tier
                    </button>
                  </div>
                  <div className="prep-field">
                    <label>Max rebuys per player</label>
                    <input
                      type="number" min={0} value={form.max_rebuys_per_player}
                      onChange={(e) => update("max_rebuys_per_player", Number(e.target.value))}
                    />
                    <small>0 = unlimited · counts across all tiers</small>
                  </div>
                </div>

                <div className="prep-divider" />

                <div className="prep-subhead">Add-ons — up to four tiers, the desk offers one button per tier</div>
                {form.addon_tiers.map((tier, index) => (
                  <div className="prep-field-grid prep-tier-row" key={index}>
                    <div className="prep-field">
                      <label>Tier {index + 1} price ($)</label>
                      <input
                        type="number" min={0} value={tier.price_cents / 100}
                        onChange={(e) => update("addon_tiers", form.addon_tiers.map((row, i) =>
                          i === index ? { ...row, price_cents: Math.round(Number(e.target.value) * 100) } : row))}
                      />
                    </div>
                    <div className="prep-field">
                      <label>Chips</label>
                      <input
                        type="number" min={0} value={tier.chips}
                        onChange={(e) => update("addon_tiers", form.addon_tiers.map((row, i) =>
                          i === index ? { ...row, chips: Number(e.target.value) } : row))}
                      />
                    </div>
                    <div className="prep-field prep-tier-row__remove">
                      <label>&nbsp;</label>
                      <button
                        type="button"
                        className="prep-tier-remove"
                        disabled={form.addon_tiers.length <= 1}
                        onClick={() => update("addon_tiers", form.addon_tiers.filter((_, i) => i !== index))}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>&nbsp;</label>
                    <button
                      type="button"
                      className="prep-tier-add"
                      disabled={form.addon_tiers.length >= 4}
                      onClick={() => {
                        const last = form.addon_tiers[form.addon_tiers.length - 1]
                        update("addon_tiers", [...form.addon_tiers, {
                          price_cents: (last?.price_cents ?? 500) * 2,
                          chips: (last?.chips ?? 10000) * 2,
                        }])
                      }}
                    >
                      + Add tier
                    </button>
                  </div>
                  <div className="prep-field">
                    <label>Max add-ons per player</label>
                    <input
                      type="number" min={0} max={5} value={form.max_addons_per_player}
                      onChange={(e) => update("max_addons_per_player", Number(e.target.value))}
                    />
                    <small>Counts across all tiers.</small>
                  </div>
                </div>
              </div>
            </section>

            <section className="prep-card">
              <div className="prep-card__head">
                <div className="prep-card__title">Jackpot</div>
              </div>
              <div className="prep-card__body">
                <label className="prep-check">
                  <input
                    type="checkbox"
                    checked={form.jackpot_enabled}
                    onChange={(e) => update("jackpot_enabled", e.target.checked)}
                  />
                  Run the jackpot at this game
                </label>

                {form.jackpot_enabled ? (
                  <div className="prep-field-grid">
                    <div className="prep-field">
                      <label>Entry ($)</label>
                      <input
                        type="number" min={0} value={form.jackpot_price_cents / 100}
                        onChange={(e) => update("jackpot_price_cents", Math.round(Number(e.target.value) * 100))}
                      />
                      <small>Entries push to the cloud pool players see online.</small>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="prep-card">
              <div className="prep-card__head">
                <div className="prep-card__title">Blind Structure</div>
                <div className="prep-card__tools">
                  {handEdited ? <span className="prep-tag">Edited by hand</span> : null}
                  <button
                    type="button"
                    className={cutOffsOpen ? "prep-btn prep-btn--green" : "prep-btn prep-btn--green-outline"}
                    onClick={() => setCutOffsOpen((current) => !current)}
                  >
                    Cut-off
                  </button>
                  <button type="button" className="prep-btn prep-btn--soft" onClick={addLevel}>
                    + Add Level
                  </button>
                </div>
              </div>

              {cutOffsOpen ? (
                <div className="prep-cutoffs">
                  <div className="prep-cutoffs__head">
                    <div className="prep-cutoffs__title">Cut-off lines</div>
                    <div className="prep-cutoffs__hint">
                      Positions in the ladder, so they follow every pause. Registration is
                      required; the rest fall back to it when left blank.
                    </div>
                  </div>
                  <div className="prep-cutoffs__grid">
                    {(Object.keys(CUT_OFF_META) as CutOffKind[])
                      .filter((kind) => kind !== "jackpot" || form.jackpot_enabled)
                      .map((kind) => (
                        <div key={kind} className="prep-field prep-field--cutoff">
                          <label>
                            {CUT_OFF_META[kind].label}
                            {kind === "registration" ? <b aria-label="required"> *</b> : null}
                          </label>
                          <input
                            type="number" min={1} max={maxPosition}
                            value={cutOffs[kind]}
                            placeholder="None"
                            onChange={(e) => setCutOffs((current) => ({
                              ...current,
                              [kind]: e.target.value === "" ? "" : Number(e.target.value),
                            }))}
                          />
                          <small>{describeCutOff(kind)}</small>
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              <div className="prep-table__wrap">
                <table className="prep-table">
                  <thead>
                    <tr>
                      <th className="prep-table__th--level">Level</th>
                      <th className="prep-table__th--type">Type</th>
                      <th>Small</th>
                      <th>Big</th>
                      <th>BB Ante</th>
                      <th>Duration</th>
                      <th className="prep-table__th--end" />
                    </tr>
                  </thead>
                  <tbody>
                    {levels.map((row, index) => {
                      const flags = marks.get(index + 1) ?? []

                      return (
                        <tr key={`${index}-${row.sort_order}`} className={flags.length ? "prep-table__row--marked" : ""}>
                          <td>
                            <div className="prep-table__level">
                              <span>{index + 1}</span>
                              <em>{row.type === "blind" ? `L${row.level_no}` : "br"}</em>
                            </div>
                          </td>
                          <td>
                            <select
                              value={row.type}
                              onChange={(e) => changeType(index, e.target.value === "break" ? "break" : "blind")}
                            >
                              <option value="blind">Blind</option>
                              <option value="break">Break</option>
                            </select>
                          </td>
                          {row.type === "break" ? (
                            <td colSpan={3}>
                              <input
                                className="prep-table__note"
                                value={row.note ?? ""}
                                placeholder="Break"
                                aria-label={`Break label for row ${index + 1}`}
                                onChange={(e) => patch(index, { note: e.target.value })}
                              />
                            </td>
                          ) : (
                            <>
                              <td>
                                <input
                                  type="number" min={0} value={row.small_blind}
                                  aria-label={`Small blind, level ${row.level_no}`}
                                  onChange={(e) => patch(index, { small_blind: Number(e.target.value) })}
                                />
                              </td>
                              <td>
                                <input
                                  type="number" min={0} value={row.big_blind}
                                  aria-label={`Big blind, level ${row.level_no}`}
                                  onChange={(e) => patch(index, { big_blind: Number(e.target.value) })}
                                />
                              </td>
                              <td>
                                <input
                                  type="number" min={0} value={row.bb_ante}
                                  aria-label={`Big blind ante, level ${row.level_no}`}
                                  onChange={(e) => patch(index, { bb_ante: Number(e.target.value) })}
                                />
                              </td>
                            </>
                          )}
                          <td>
                            <input
                              type="number" min={1} max={600} value={row.duration_min}
                              aria-label={`Minutes, row ${index + 1}`}
                              onChange={(e) => patch(index, { duration_min: Number(e.target.value) })}
                            />
                          </td>
                          <td className="prep-table__end">
                            {flags.map((flag) => (
                              <span
                                key={flag}
                                className={`prep-flag prep-flag--${flag}`}
                                title={`${CUT_OFF_META[flag].label} closes here`}
                              >
                                {CUT_OFF_META[flag].short}
                              </span>
                            ))}
                            <button type="button" className="prep-btn prep-btn--row" onClick={() => removeLevel(index)}>
                              Delete
                            </button>
                          </td>
                        </tr>
                      )
                    })}

                    {levels.length === 0 ? (
                      <tr>
                        <td className="prep-table__empty" colSpan={7}>
                          No levels. Add at least one blind level.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="prep-side">
            <section className="prep-card">
              <div className="prep-card__head">
                <div className="prep-card__title">Fill from a pattern</div>
              </div>
              <div className="prep-card__body">
                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Levels</label>
                    <input
                      type="number" min={1} max={60} value={pattern.levels}
                      onChange={(e) => updatePattern("levels", Number(e.target.value))}
                    />
                  </div>
                  <div className="prep-field">
                    <label>Minutes</label>
                    <input
                      type="number" min={1} max={180} value={pattern.duration_min}
                      onChange={(e) => updatePattern("duration_min", Number(e.target.value))}
                    />
                  </div>
                  <div className="prep-field">
                    <label>Opening SB</label>
                    <input
                      type="number" min={1} value={pattern.small_blind}
                      onChange={(e) => updatePattern("small_blind", Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Increase</label>
                    <div className="prep-segmented" role="group" aria-label="Blind increase mode">
                      <button
                        type="button"
                        className={pattern.mode === "multiply" ? "is-on" : ""}
                        onClick={() => updatePattern("mode", "multiply")}
                      >
                        Multiply
                      </button>
                      <button
                        type="button"
                        className={pattern.mode === "add" ? "is-on" : ""}
                        onClick={() => updatePattern("mode", "add")}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                  <div className="prep-field">
                    <label>{pattern.mode === "multiply" ? "Factor" : "Step"}</label>
                    <input
                      type="number" min={0.1} step={pattern.mode === "multiply" ? 0.1 : 50}
                      value={pattern.step}
                      onChange={(e) => updatePattern("step", Number(e.target.value))}
                    />
                    <small>
                      {pattern.mode === "multiply"
                        ? "Each level's blinds ≈ previous × this. 1.5 = +50% per level."
                        : "Blinds grow by this many chips each level."}
                    </small>
                  </div>
                  <div className="prep-field">
                    <label>Antes from</label>
                    <input
                      type="number" min={1} value={pattern.ante_from_level}
                      placeholder="None"
                      onChange={(e) => updatePattern("ante_from_level", e.target.value === "" ? "" : Number(e.target.value))}
                    />
                    <small>Level antes start. Empty = no antes all night.</small>
                  </div>
                </div>

                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Break every</label>
                    <input
                      type="number" min={0} max={20} value={pattern.break_every}
                      onChange={(e) => updatePattern("break_every", Number(e.target.value))}
                    />
                    <small>0 = none</small>
                  </div>
                  <div className="prep-field">
                    <label>Break length</label>
                    <input
                      type="number" min={1} max={120} value={pattern.break_duration_min}
                      onChange={(e) => updatePattern("break_duration_min", Number(e.target.value))}
                    />
                  </div>
                  <div className="prep-field prep-field--action">
                    <button
                      type="button"
                      className="prep-btn prep-btn--green"
                      disabled={generating}
                      onClick={() => void generate()}
                    >
                      {generating ? "Generating…" : handEdited ? "Replace ladder" : "Generate"}
                    </button>
                    {handEdited ? <small>Discards your edits</small> : null}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>

      {confirmReplace ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => setConfirmReplace(null)}>
          <section className="host-scan-modal__panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="host-finish__confirm-title">Erase the open session?</h3>
            <p className="host-finish__confirm-copy">
              “{confirmReplace.name ?? "The current session"}” is still open
              {confirmReplace.status === "draft" ? "" : " and has already started"}. Creating this new session
              will <strong>erase it from this laptop</strong> — every registration and buy-in recorded on it is
              deleted, with <strong>no way back</strong>. The online game itself stays open, so any desk can
              still host it.
            </p>
            <footer className="host-scan-modal__footer">
              <span className="host-scan-modal__total" />
              <button type="button" className="host-scan-modal__cancel" onClick={() => setConfirmReplace(null)}>
                Keep that session
              </button>
              <button
                type="button"
                className="host-scan-modal__submit"
                onClick={() => {
                  const id = confirmReplace.id
                  setConfirmReplace(null)
                  void open(id)
                }}
              >
                Erase it and create new
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}

function Chip({ label, value }: { label: string, value: string }) {
  return (
    <span className="prep-chip">
      {label}
      <span className="prep-chip__value">{value}</span>
    </span>
  )
}
