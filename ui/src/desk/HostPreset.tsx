import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowRight, Loader2, Wand2 } from "lucide-react"
import LadderEditor, { CUT_OFF_META, type CutOffKind } from "./LadderEditor"
import { deskApi, money, type GeneratedLevel, type Venue } from "./deskApi"

type Props = {
  venue: Venue | null
  onOpened: (sessionId: number) => void
}

type Optional = number | ""

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

/**
 * The screen the operator fills in before the doors open.
 *
 * Everything that costs money and every cut-off is decided here, because
 * changing the price of a rebuy once players are in the room is not a
 * conversation anyone wants to have.
 *
 * The pattern generator is a starting point, not a constraint: it fills the
 * ladder in one action, and from then on every level is edited directly. Real
 * structures nearly always break the pattern somewhere.
 */
export default function HostPreset({ venue, onOpened }: Props) {
  const [form, setForm] = useState(DEFAULTS)
  const [pattern, setPattern] = useState(PATTERN)
  const [levels, setLevels] = useState<GeneratedLevel[]>([])
  const [cutOffs, setCutOffs] = useState<Record<CutOffKind, Optional>>({
    registration: 6,
    rebuy: "",
    addon: "",
    jackpot: "",
  })
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [generating, setGenerating] = useState(false)

  // Once a level has been touched by hand the pattern stops driving the
  // ladder — silently overwriting someone's tuned structure would be the
  // worst thing this screen could do.
  const [handEdited, setHandEdited] = useState(false)
  const loadedOnce = useRef(false)

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
  // generating is an explicit act.
  useEffect(() => {
    if (loadedOnce.current) return
    loadedOnce.current = true
    void generate()
  }, [generate])

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
    if (!position) return kind === "addon" ? "No cut-off" : "Same as registration"

    const row = levels[position - 1]
    if (!row) return `Row ${position}`

    const label = row.type === "break"
      ? (row.note || "Break")
      : `${row.small_blind.toLocaleString()} / ${row.big_blind.toLocaleString()}`

    return `${label} · ${minutesBefore(position)} min in`
  }

  async function open() {
    setError(null)

    if (!form.name.trim()) {
      setError("Give the tournament a name.")
      return
    }

    if (cutOffs.registration === "") {
      setError("Set the level registration closes at — everything else hangs off it.")
      return
    }

    setOpening(true)

    try {
      const optional = (value: Optional) => (value === "" ? null : Number(value))

      const created = await deskApi.createTournament({
        ...form,
        name: form.name.trim(),
        venue_id: venue?.id ?? null,
        venue_name: venue?.name ?? null,
        registration_closes_at_level: Number(cutOffs.registration),
        rebuy_closes_at_level: optional(cutOffs.rebuy),
        addon_closes_at_level: optional(cutOffs.addon),
        jackpot_closes_at_level: optional(cutOffs.jackpot),
        levels,
      })

      onOpened(created.session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The session could not be opened.")
    } finally {
      setOpening(false)
    }
  }

  const maxPosition = Math.max(1, levels.length)

  return (
    <div className="preset">
      <header className="preset__bar">
        <div className="preset__title">
          <h2>Set up tonight&rsquo;s game</h2>
          <p>{venue ? `Hosting at ${venue.name}` : "Choose a venue in the header to continue"}</p>
        </div>

        <div className="preset__totals">
          <span><small>Buy-in</small>{money(form.buy_in_price_cents)}</span>
          <span><small>Rebuy</small>{money(form.rebuy_price_cents)}</span>
          <span><small>Add-on</small>{money(form.addon_price_cents)}</span>
          {form.jackpot_enabled ? <span><small>Jackpot</small>{money(form.jackpot_price_cents)}</span> : null}
        </div>

        <button className="preset__open" type="button" disabled={opening || !venue} onClick={() => void open()}>
          {opening ? <Loader2 size={16} className="host-spin" /> : <ArrowRight size={16} />}
          {opening ? "Opening…" : "Open session"}
        </button>
      </header>

      {error ? <p className="preset__error" role="alert">{error}</p> : null}

      <div className="preset__layout">
        <div className="preset__side">
          <section className="panel">
            <h3>The game</h3>

            <label className="field">
              <span>Tournament name</span>
              <input value={form.name} placeholder="Thursday Deepstack"
                onChange={(e) => update("name", e.target.value)} />
            </label>

            <div className="field-row">
              <label className="field">
                <span>Buy-in</span>
                <div className="field__money">
                  <em>$</em>
                  <input type="number" min={0} value={form.buy_in_price_cents / 100}
                    onChange={(e) => update("buy_in_price_cents", Math.round(Number(e.target.value) * 100))} />
                </div>
              </label>
              <label className="field">
                <span>Starting stack</span>
                <input type="number" min={1} value={form.starting_stack}
                  onChange={(e) => update("starting_stack", Number(e.target.value))} />
              </label>
            </div>

            <div className="field-row">
              <label className="field">
                <span>Seats per table</span>
                <input type="number" min={2} max={10} value={form.seats_per_table}
                  onChange={(e) => update("seats_per_table", Number(e.target.value))} />
              </label>
            </div>
          </section>

          <section className="panel">
            <h3>Rebuys &amp; add-ons</h3>

            <div className="field-row">
              <label className="field">
                <span>Rebuy</span>
                <div className="field__money">
                  <em>$</em>
                  <input type="number" min={0} value={form.rebuy_price_cents / 100}
                    onChange={(e) => update("rebuy_price_cents", Math.round(Number(e.target.value) * 100))} />
                </div>
              </label>
              <label className="field">
                <span>Chips</span>
                <input type="number" min={0} value={form.rebuy_chips}
                  onChange={(e) => update("rebuy_chips", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Max</span>
                <input type="number" min={0} value={form.max_rebuys_per_player}
                  onChange={(e) => update("max_rebuys_per_player", Number(e.target.value))} />
                <small>0 = unlimited</small>
              </label>
            </div>

            <div className="field-row">
              <label className="field">
                <span>Add-on</span>
                <div className="field__money">
                  <em>$</em>
                  <input type="number" min={0} value={form.addon_price_cents / 100}
                    onChange={(e) => update("addon_price_cents", Math.round(Number(e.target.value) * 100))} />
                </div>
              </label>
              <label className="field">
                <span>Chips</span>
                <input type="number" min={0} value={form.addon_chips}
                  onChange={(e) => update("addon_chips", Number(e.target.value))} />
              </label>
              <label className="field">
                <span>Max</span>
                <input type="number" min={0} max={5} value={form.max_addons_per_player}
                  onChange={(e) => update("max_addons_per_player", Number(e.target.value))} />
              </label>
            </div>
          </section>

          <section className="panel">
            <h3>Jackpot</h3>

            <label className="switch">
              <input type="checkbox" checked={form.jackpot_enabled}
                onChange={(e) => update("jackpot_enabled", e.target.checked)} />
              <span className="switch__track" aria-hidden="true"><i /></span>
              <span className="switch__label">Run the jackpot at this game</span>
            </label>

            {form.jackpot_enabled ? (
              <label className="field">
                <span>Entry</span>
                <div className="field__money">
                  <em>$</em>
                  <input type="number" min={0} value={form.jackpot_price_cents / 100}
                    onChange={(e) => update("jackpot_price_cents", Math.round(Number(e.target.value) * 100))} />
                </div>
                <small>Entries push to the cloud pool players see online.</small>
              </label>
            ) : null}
          </section>

          <section className="panel">
            <h3>Cut-off lines</h3>
            <p className="panel__hint">
              Positions in the ladder, so they follow every pause. Registration is
              required; the rest fall back to it when left blank.
            </p>

            {(Object.keys(CUT_OFF_META) as CutOffKind[])
              .filter((kind) => kind !== "jackpot" || form.jackpot_enabled)
              .map((kind) => (
                <label key={kind} className={`cutoff cutoff--${kind}`}>
                  <span className="cutoff__name">
                    {CUT_OFF_META[kind].label}
                    {kind === "registration" ? <b aria-label="required">*</b> : null}
                  </span>
                  <input
                    type="number" min={1} max={maxPosition}
                    value={cutOffs[kind]}
                    placeholder={kind === "addon" ? "None" : "Same"}
                    onChange={(e) => setCutOffs((current) => ({
                      ...current,
                      [kind]: e.target.value === "" ? "" : Number(e.target.value),
                    }))}
                  />
                  <small>{describeCutOff(kind)}</small>
                </label>
              ))}
          </section>
        </div>

        <section className="panel panel--structure">
          <div className="panel__head">
            <h3>Blind structure</h3>
            {handEdited ? <span className="panel__tag">Edited by hand</span> : null}
          </div>

          <details className="pattern" open={!handEdited}>
            <summary>
              <Wand2 size={14} />
              Fill from a pattern
              <em>{pattern.levels} levels · {pattern.duration_min}m · {pattern.mode === "multiply" ? `×${pattern.step}` : `+${pattern.step}`}</em>
            </summary>

            <div className="pattern__body">
              <div className="field-row">
                <label className="field">
                  <span>Levels</span>
                  <input type="number" min={1} max={60} value={pattern.levels}
                    onChange={(e) => updatePattern("levels", Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Minutes</span>
                  <input type="number" min={1} max={180} value={pattern.duration_min}
                    onChange={(e) => updatePattern("duration_min", Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Opening SB</span>
                  <input type="number" min={1} value={pattern.small_blind}
                    onChange={(e) => updatePattern("small_blind", Number(e.target.value))} />
                </label>
              </div>

              <div className="field-row">
                <div className="field">
                  <span>Increase</span>
                  <div className="segmented" role="group" aria-label="Blind increase mode">
                    <button type="button" className={pattern.mode === "multiply" ? "is-on" : ""}
                      onClick={() => updatePattern("mode", "multiply")}>Multiply</button>
                    <button type="button" className={pattern.mode === "add" ? "is-on" : ""}
                      onClick={() => updatePattern("mode", "add")}>Add</button>
                  </div>
                </div>
                <label className="field">
                  <span>{pattern.mode === "multiply" ? "Factor" : "Step"}</span>
                  <input type="number" min={0.1} step={pattern.mode === "multiply" ? 0.1 : 50}
                    value={pattern.step}
                    onChange={(e) => updatePattern("step", Number(e.target.value))} />
                </label>
                <label className="field">
                  <span>Antes from</span>
                  <input type="number" min={1} value={pattern.ante_from_level}
                    placeholder="None"
                    onChange={(e) => updatePattern("ante_from_level", e.target.value === "" ? "" : Number(e.target.value))} />
                </label>
              </div>

              <div className="field-row">
                <label className="field">
                  <span>Break every</span>
                  <input type="number" min={0} max={20} value={pattern.break_every}
                    onChange={(e) => updatePattern("break_every", Number(e.target.value))} />
                  <small>0 = none</small>
                </label>
                <label className="field">
                  <span>Break length</span>
                  <input type="number" min={1} max={120} value={pattern.break_duration_min}
                    onChange={(e) => updatePattern("break_duration_min", Number(e.target.value))} />
                </label>
                <div className="field field--action">
                  <button type="button" className="pattern__apply" disabled={generating}
                    onClick={() => void generate()}>
                    {generating ? <Loader2 size={14} className="host-spin" /> : <Wand2 size={14} />}
                    {handEdited ? "Replace ladder" : "Generate"}
                  </button>
                  {handEdited ? <small>Discards your edits</small> : null}
                </div>
              </div>
            </div>
          </details>

          <LadderEditor
            levels={levels}
            cutOffs={numericCutOffs}
            onChange={(next) => {
              setLevels(next)
              setHandEdited(true)
            }}
          />
        </section>
      </div>
    </div>
  )
}
