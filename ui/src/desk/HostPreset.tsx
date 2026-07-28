import { useCallback, useEffect, useMemo, useState } from "react"
import { ChevronRight, Coins, Clock, Loader2, TicketPercent } from "lucide-react"
import { deskApi, money, type GeneratedLevel, type Venue } from "./deskApi"

type Props = {
  venue: Venue | null
  onOpened: (sessionId: number) => void
}

const DEFAULTS = {
  name: "",
  seats_per_table: 8,
  starting_stack: 20000,
  buy_in_price_cents: 10000,
  rebuy_chips: 20000,
  rebuy_price_cents: 10000,
  max_rebuys_per_player: 0,
  addon_chips: 30000,
  addon_price_cents: 5000,
  max_addons_per_player: 1,
  jackpot_enabled: true,
  jackpot_price_cents: 1000,
  registration_closes_at_level: 6,
  rebuy_closes_at_level: "" as number | "",
  addon_closes_at_level: "" as number | "",
  jackpot_closes_at_level: "" as number | "",
}

const STRUCTURE_DEFAULTS = {
  levels: 18,
  duration_min: 20,
  small_blind: 100,
  big_blind_multiple: 2,
  mode: "multiply" as "multiply" | "add",
  step: 1.5,
  break_every: 6,
  break_duration_min: 15,
  ante_from_level: 5 as number | "",
  ante_as_big_blind: true,
}

/**
 * The screen the operator fills in before the doors open.
 *
 * Everything that costs money, and every cut-off, is decided here — once
 * players are in the room, changing the price of a rebuy retroactively is not
 * a thing anybody wants to explain. The blind ladder is generated from a
 * pattern and previewed in full, because a structure is much easier to judge
 * as a list than as four numbers.
 */
export default function HostPreset({ venue, onOpened }: Props) {
  const [form, setForm] = useState(DEFAULTS)
  const [structure, setStructure] = useState(STRUCTURE_DEFAULTS)
  const [levels, setLevels] = useState<GeneratedLevel[]>([])
  const [totalMinutes, setTotalMinutes] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const updateStructure = <K extends keyof typeof structure>(key: K, value: (typeof structure)[K]) =>
    setStructure((current) => ({ ...current, [key]: value }))

  const previewStructure = useCallback(async () => {
    try {
      const result = await deskApi.previewStructure({
        ...structure,
        ante_from_level: structure.ante_from_level === "" ? null : structure.ante_from_level,
      })
      setLevels(result.levels)
      setTotalMinutes(result.total_minutes)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The structure could not be generated.")
    }
  }, [structure])

  // Regenerate as the pattern changes — the ladder is the point of this
  // screen, so it should never be stale relative to the inputs above it.
  useEffect(() => {
    void previewStructure()
  }, [previewStructure])

  const cutOffLabel = useMemo(() => {
    const level = levels[form.registration_closes_at_level - 1]
    if (!level) return "—"
    const minutes = levels
      .slice(0, form.registration_closes_at_level)
      .reduce((sum, row) => sum + row.duration_min, 0)
    return `${minutes} min of play`
  }, [levels, form.registration_closes_at_level])

  async function open() {
    setError(null)

    if (!form.name.trim()) {
      setError("Give the tournament a name.")
      return
    }

    setOpening(true)

    try {
      const optional = (value: number | "") => (value === "" ? null : Number(value))

      const created = await deskApi.createTournament({
        ...form,
        name: form.name.trim(),
        venue_id: venue?.id ?? null,
        venue_name: venue?.name ?? null,
        rebuy_closes_at_level: optional(form.rebuy_closes_at_level),
        addon_closes_at_level: optional(form.addon_closes_at_level),
        jackpot_closes_at_level: optional(form.jackpot_closes_at_level),
        levels,
      })

      onOpened(created.session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The session could not be opened.")
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="host-preset">
      <header className="host-preset__head">
        <div>
          <h2>Set up tonight&rsquo;s game</h2>
          <p>
            {venue ? `Hosting at ${venue.name}.` : "Choose a venue in the header first."} Prices and
            cut-offs are locked in when the session opens.
          </p>
        </div>
        <button className="host-preset__open" type="button" disabled={opening || !venue} onClick={() => void open()}>
          {opening ? <Loader2 size={16} className="host-spin" /> : <ChevronRight size={16} />}
          {opening ? "Opening…" : "Open session"}
        </button>
      </header>

      {error ? <p className="host-preset__error" role="alert">{error}</p> : null}

      <div className="host-preset__grid">
        <section className="host-card">
          <h3><Coins size={15} /> Money</h3>

          <label>
            <span>Tournament name</span>
            <input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Thursday Deepstack" />
          </label>

          <div className="host-card__row">
            <label>
              <span>Buy-in</span>
              <input type="number" min={0} value={form.buy_in_price_cents / 100}
                onChange={(e) => update("buy_in_price_cents", Math.round(Number(e.target.value) * 100))} />
            </label>
            <label>
              <span>Starting stack</span>
              <input type="number" min={1} value={form.starting_stack}
                onChange={(e) => update("starting_stack", Number(e.target.value))} />
            </label>
          </div>

          <div className="host-card__row">
            <label>
              <span>Rebuy</span>
              <input type="number" min={0} value={form.rebuy_price_cents / 100}
                onChange={(e) => update("rebuy_price_cents", Math.round(Number(e.target.value) * 100))} />
            </label>
            <label>
              <span>Rebuy chips</span>
              <input type="number" min={0} value={form.rebuy_chips}
                onChange={(e) => update("rebuy_chips", Number(e.target.value))} />
            </label>
            <label>
              <span>Max rebuys</span>
              <input type="number" min={0} value={form.max_rebuys_per_player}
                onChange={(e) => update("max_rebuys_per_player", Number(e.target.value))} />
              <small>0 = unlimited</small>
            </label>
          </div>

          <div className="host-card__row">
            <label>
              <span>Add-on</span>
              <input type="number" min={0} value={form.addon_price_cents / 100}
                onChange={(e) => update("addon_price_cents", Math.round(Number(e.target.value) * 100))} />
            </label>
            <label>
              <span>Add-on chips</span>
              <input type="number" min={0} value={form.addon_chips}
                onChange={(e) => update("addon_chips", Number(e.target.value))} />
            </label>
            <label>
              <span>Max add-ons</span>
              <input type="number" min={0} max={5} value={form.max_addons_per_player}
                onChange={(e) => update("max_addons_per_player", Number(e.target.value))} />
            </label>
          </div>

          <label className="host-card__check">
            <input type="checkbox" checked={form.jackpot_enabled}
              onChange={(e) => update("jackpot_enabled", e.target.checked)} />
            <span>Run the jackpot at this game</span>
          </label>

          {form.jackpot_enabled ? (
            <label>
              <span>Jackpot entry</span>
              <input type="number" min={0} value={form.jackpot_price_cents / 100}
                onChange={(e) => update("jackpot_price_cents", Math.round(Number(e.target.value) * 100))} />
              <small>Entries are pushed to the cloud pool players see online.</small>
            </label>
          ) : null}
        </section>

        <section className="host-card">
          <h3><Clock size={15} /> Blind structure</h3>

          <div className="host-card__row">
            <label>
              <span>Levels</span>
              <input type="number" min={1} max={60} value={structure.levels}
                onChange={(e) => updateStructure("levels", Number(e.target.value))} />
            </label>
            <label>
              <span>Minutes each</span>
              <input type="number" min={1} max={180} value={structure.duration_min}
                onChange={(e) => updateStructure("duration_min", Number(e.target.value))} />
            </label>
            <label>
              <span>Opening SB</span>
              <input type="number" min={1} value={structure.small_blind}
                onChange={(e) => updateStructure("small_blind", Number(e.target.value))} />
            </label>
          </div>

          <div className="host-card__row">
            <label>
              <span>Increase by</span>
              <select value={structure.mode}
                onChange={(e) => updateStructure("mode", e.target.value as "multiply" | "add")}>
                <option value="multiply">Multiply (&times;)</option>
                <option value="add">Add (+)</option>
              </select>
            </label>
            <label>
              <span>{structure.mode === "multiply" ? "Factor" : "Step"}</span>
              <input type="number" min={0.1} step={structure.mode === "multiply" ? 0.1 : 50}
                value={structure.step}
                onChange={(e) => updateStructure("step", Number(e.target.value))} />
              <small>{structure.mode === "multiply" ? "e.g. 2.0 doubles" : "e.g. +500"}</small>
            </label>
            <label>
              <span>Break every</span>
              <input type="number" min={0} max={20} value={structure.break_every}
                onChange={(e) => updateStructure("break_every", Number(e.target.value))} />
              <small>0 = no breaks</small>
            </label>
          </div>

          <div className="host-card__row">
            <label>
              <span>Break length</span>
              <input type="number" min={1} max={120} value={structure.break_duration_min}
                onChange={(e) => updateStructure("break_duration_min", Number(e.target.value))} />
            </label>
            <label>
              <span>Antes from level</span>
              <input type="number" min={1} value={structure.ante_from_level}
                onChange={(e) => updateStructure("ante_from_level", e.target.value === "" ? "" : Number(e.target.value))} />
              <small>Blank for none</small>
            </label>
            <label>
              <span>Seats per table</span>
              <input type="number" min={2} max={10} value={form.seats_per_table}
                onChange={(e) => update("seats_per_table", Number(e.target.value))} />
            </label>
          </div>

          <div className="host-ladder">
            <div className="host-ladder__head">
              <strong>{levels.length} rows</strong>
              <span>{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m total</span>
            </div>
            <ol className="host-ladder__list">
              {levels.map((level, index) => (
                <li key={level.sort_order}
                  className={[
                    level.type === "break" ? "is-break" : "",
                    index + 1 === form.registration_closes_at_level ? "is-cutoff" : "",
                  ].filter(Boolean).join(" ")}>
                  <span className="host-ladder__no">{index + 1}</span>
                  {level.type === "break" ? (
                    <span className="host-ladder__blinds">Break</span>
                  ) : (
                    <span className="host-ladder__blinds">
                      {level.small_blind.toLocaleString()} / {level.big_blind.toLocaleString()}
                      {level.bb_ante > 0 ? <em> ({level.bb_ante.toLocaleString()} ante)</em> : null}
                    </span>
                  )}
                  <span className="host-ladder__mins">{level.duration_min}m</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="host-card">
          <h3><TicketPercent size={15} /> Cut-off lines</h3>
          <p className="host-card__hint">
            Cut-offs are positions in the ladder above, so they follow every pause.
            Registration is required; the rest fall back to it when left blank, and
            only take effect once you enter them.
          </p>

          <label>
            <span>Registration closes at *</span>
            <input type="number" min={1} max={Math.max(1, levels.length)}
              value={form.registration_closes_at_level}
              onChange={(e) => update("registration_closes_at_level", Number(e.target.value))} />
            <small>{cutOffLabel} &middot; online registration closes at the same point</small>
          </label>

          <label>
            <span>Rebuys close at</span>
            <input type="number" min={1} max={Math.max(1, levels.length)}
              value={form.rebuy_closes_at_level}
              placeholder="Same as registration"
              onChange={(e) => update("rebuy_closes_at_level", e.target.value === "" ? "" : Number(e.target.value))} />
          </label>

          <label>
            <span>Add-ons close at</span>
            <input type="number" min={1} max={Math.max(1, levels.length)}
              value={form.addon_closes_at_level}
              placeholder="No cut-off"
              onChange={(e) => update("addon_closes_at_level", e.target.value === "" ? "" : Number(e.target.value))} />
          </label>

          {form.jackpot_enabled ? (
            <label>
              <span>Jackpot closes at</span>
              <input type="number" min={1} max={Math.max(1, levels.length)}
                value={form.jackpot_closes_at_level}
                placeholder="Same as registration"
                onChange={(e) => update("jackpot_closes_at_level", e.target.value === "" ? "" : Number(e.target.value))} />
            </label>
          ) : null}

          <dl className="host-summary">
            <div><dt>Buy-in</dt><dd>{money(form.buy_in_price_cents)}</dd></div>
            <div><dt>Rebuy</dt><dd>{money(form.rebuy_price_cents)}</dd></div>
            <div><dt>Add-on</dt><dd>{money(form.addon_price_cents)} &times;{form.max_addons_per_player}</dd></div>
            {form.jackpot_enabled ? <div><dt>Jackpot</dt><dd>{money(form.jackpot_price_cents)}</dd></div> : null}
          </dl>
        </section>
      </div>
    </div>
  )
}
