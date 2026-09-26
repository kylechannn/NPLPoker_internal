import { useCallback, useEffect, useMemo, useState } from "react"
import { CloudUpload, KeyRound, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react"
import {
  deskApi,
  DeskApiError,
  money,
  type AddonTier,
  type CashStructureSettings,
  type GameStructure,
  type GeneratedLevel,
  type StructurePattern,
  type TournamentStructureSettings,
} from "../desk/deskApi"
import "../desk/preparation.css"
import "../desk/host.css"
import "./structure.css"

export type ConsoleIdentity = {
  id: string
  name: string
  role: string
  initials: string
  role_key?: string
  super_admin?: boolean
  admin_token?: string | null
  admin_token_expires_at?: string | null
}

type Props = {
  staff: ConsoleIdentity | null
  onNotice: (message: string) => void
  /** A fresh sign-in (the saved token had expired) — stored like the gate's. */
  onIdentityRefresh: (identity: ConsoleIdentity) => void
}

type CutOffKind = "registration" | "rebuy" | "addon" | "jackpot"

const CUT_OFF_META: Record<CutOffKind, { label: string, short: string, field: keyof TournamentStructureSettings }> = {
  registration: { label: "Registration", short: "REG", field: "registration_closes_at_level" },
  rebuy: { label: "Rebuys", short: "RE", field: "rebuy_closes_at_level" },
  addon: { label: "Add-ons", short: "ADD", field: "addon_closes_at_level" },
  jackpot: { label: "Jackpot", short: "JP", field: "jackpot_closes_at_level" },
}

const DEFAULT_PATTERN: StructurePattern = {
  levels: 18,
  duration_min: 20,
  small_blind: 100,
  big_blind_multiple: 2,
  mode: "multiply",
  step: 1.5,
  break_every: 6,
  break_duration_min: 15,
  ante_from_level: 5,
  ante_as_big_blind: true,
}

/**
 * Level numbers are derived, never typed: blinds count up, and a break
 * carries the number of the level before it, so "registration closes at
 * row 6" keeps meaning the same thing however the ladder is edited.
 */
function renumber(rows: GeneratedLevel[]): GeneratedLevel[] {
  let levelNo = 0

  return rows.map((row, index) => {
    if (row.type === "blind") levelNo += 1

    return { ...row, level_no: levelNo || 1, sort_order: index + 1 }
  })
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return "—"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(parsed)
}

/**
 * The Game Structure tab — super admin only. The base setup every venue
 * desk opens its games from: the tournament desk's prices, tiers, caps,
 * jackpot, cut-off lines and blind ladder, and the cash desk's prices and
 * time cut-offs. A save goes to the NPL cloud's database as the signed-in
 * super admin (their own sign-in, never the desk's licence); every desk
 * picks it up on its next open. Nothing here is per venue.
 */
export default function GameStructureWorkspace({ staff, onNotice, onIdentityRefresh }: Props) {
  const isSuperAdmin = staff?.super_admin === true || staff?.role_key === "super_admin"

  const [structure, setStructure] = useState<GameStructure | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true)
    try {
      const result = await deskApi.gameStructure(refresh)
      setStructure(result)
      setLoadError(null)
      if (refresh && result.warning) onNotice(`Showing this desk's copy — ${result.warning}`)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "The game structure could not be loaded.")
    } finally {
      if (refresh) setRefreshing(false)
    }
  }, [onNotice])

  useEffect(() => {
    void load(true)
  }, [load])

  if (!isSuperAdmin) {
    return (
      <div className="structure-locked" role="alert">
        <ShieldAlert size={24} />
        <h2>Super admin only</h2>
        <p>The game structure is set by NPL head office. Open tonight's game from the Tournament, Cash Game or Events tab — it opens straight into registration on the current defaults.</p>
      </div>
    )
  }

  return (
    <div className="prep structure">
      <div className="prep__container">
        <div className="prep__top">
          <div className="structure-head">
            <div>
              <h2>Game Structure</h2>
              <p>
                The base setup every venue desk opens its games from. Save writes straight to the NPL
                cloud&rsquo;s database; tournament directors and admins never see a preparation screen —
                Open desk lands in registration on exactly this.
              </p>
            </div>
            <div className="structure-kind__actions">
              {structure ? (
                <span className={structure.tournament.source === "cloud" || structure.cash.source === "cloud" ? "structure-source structure-source--cloud" : "structure-source"}>
                  <ShieldCheck size={14} />
                  {structure.tournament.source === "cloud" || structure.cash.source === "cloud"
                    ? "Saved on the NPL cloud"
                    : "Built-in defaults — nothing saved yet"}
                  <small>· mirrored {formatStamp(structure.pulled_at)}</small>
                </span>
              ) : null}
              <button type="button" className="prep-btn prep-btn--soft" disabled={refreshing} onClick={() => void load(true)}>
                <RefreshCw size={14} /> {refreshing ? "Refreshing…" : "Refresh from cloud"}
              </button>
            </div>
          </div>
        </div>

        {loadError ? <div className="prep-error" role="alert">{loadError}</div> : null}

        {structure === null ? (
          loadError ? null : <p className="host-hub__empty"><Loader2 size={16} className="host-spin" /> Loading the game structure…</p>
        ) : (
          <>
            <TournamentStructureEditor
              key={`t-${structure.tournament.cloud_updated_at ?? "built-in"}-${structure.pulled_at ?? ""}`}
              block={structure.tournament}
              staff={staff}
              onSaved={(next) => {
                setStructure(next)
                onNotice("Tournament structure saved to the NPL cloud — every desk opens its next tournament on it.")
              }}
              onIdentityRefresh={onIdentityRefresh}
            />

            <CashStructureEditor
              key={`c-${structure.cash.cloud_updated_at ?? "built-in"}-${structure.pulled_at ?? ""}`}
              block={structure.cash}
              staff={staff}
              onSaved={(next) => {
                setStructure(next)
                onNotice("Cash game structure saved to the NPL cloud — every desk opens its next cash game on it.")
              }}
              onIdentityRefresh={onIdentityRefresh}
            />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Saving as the super admin. The console keeps their sign-in token for
 * exactly this; when it has lapsed (or the cloud says so), the password is
 * asked for again right here and the save retried with the fresh token.
 */
function useCloudSave(
  staff: ConsoleIdentity | null,
  onIdentityRefresh: (identity: ConsoleIdentity) => void,
) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [reauth, setReauth] = useState<{ run: (token: string) => Promise<void> } | null>(null)

  const save = useCallback(async (
    run: (token: string) => Promise<GameStructure>,
    onSaved: (next: GameStructure) => void,
    token: string | null = staff?.admin_token ?? null,
  ) => {
    setError(null)

    const attempt = async (withToken: string) => {
      setSaving(true)
      try {
        const next = await run(withToken)
        setSavedAt(new Date().toISOString())
        onSaved(next)
      } finally {
        setSaving(false)
      }
    }

    if (!token) {
      setReauth({ run: attempt })
      return
    }

    try {
      await attempt(token)
    } catch (e) {
      if (e instanceof DeskApiError && (e.code === "ADMIN_SIGN_IN_EXPIRED" || e.code === "ADMIN_SIGN_IN_REQUIRED")) {
        setReauth({ run: attempt })
        return
      }
      setError(e instanceof Error ? e.message : "The game structure could not be saved.")
    }
  }, [staff?.admin_token])

  const dialog = reauth && staff ? (
    <ReauthDialog
      staff={staff}
      onCancel={() => setReauth(null)}
      onSignedIn={async (identity) => {
        onIdentityRefresh(identity)
        const pending = reauth
        setReauth(null)
        if (!identity.admin_token) {
          setError("That sign-in is not a super admin — the game structure was not saved.")
          return
        }
        try {
          await pending.run(identity.admin_token)
        } catch (e) {
          setError(e instanceof Error ? e.message : "The game structure could not be saved.")
        }
      }}
    />
  ) : null

  return { save, saving, error, savedAt, dialog, clearError: () => setError(null) }
}

function ReauthDialog({ staff, onCancel, onSignedIn }: {
  staff: ConsoleIdentity
  onCancel: () => void
  onSignedIn: (identity: ConsoleIdentity) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/v1/console/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ login: staff.id, password }),
      })
      const body = await response.json() as { ok?: boolean, data?: { identity?: ConsoleIdentity }, error?: { message?: string } }
      if (!response.ok || !body.ok || !body.data?.identity) {
        setError(body.error?.message ?? "The sign-in could not be completed. Try again.")
        return
      }
      await onSignedIn(body.data.identity)
    } catch {
      setError("The local service could not be reached. Try again in a moment.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="host-scan-modal" role="presentation" onMouseDown={() => { if (!busy) onCancel() }}>
      <section className="host-scan-modal__panel" role="dialog" aria-modal="true" aria-label="Confirm your admin password" onMouseDown={(e) => e.stopPropagation()}>
        <form className="structure-reauth" onSubmit={(event) => void submit(event)}>
          <h3>Confirm your admin password</h3>
          <p>
            Saving the game structure changes the NPL cloud for every venue, so it is done as you —
            your console sign-in has lapsed. Enter the password for <strong>{staff.id}</strong> to save.
          </p>
          <label>
            <span><KeyRound size={13} /> Password</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              autoFocus
              maxLength={128}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error ? <p className="host-desk__error" role="alert">{error}</p> : null}
          <footer className="host-scan-modal__footer">
            <span className="host-scan-modal__total" />
            <button type="button" className="host-scan-modal__cancel" disabled={busy} onClick={onCancel}>Cancel</button>
            <button type="submit" className="host-scan-modal__submit" disabled={busy || password === ""}>
              {busy ? "Signing in…" : "Sign in and save"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

function KindHeader({ title, hint, block, saving, savedAt, onSave }: {
  title: string
  hint: string
  block: GameStructure["tournament"] | GameStructure["cash"]
  saving: boolean
  savedAt: string | null
  onSave: () => void
}) {
  return (
    <div className="structure-kind__head">
      <div>
        <h3>{title}</h3>
        <small>
          {hint}
          {block.source === "cloud"
            ? ` · saved on the cloud ${formatStamp(block.cloud_updated_at)}${block.updated_by ? ` by ${block.updated_by}` : ""}`
            : " · built-in defaults until saved"}
        </small>
      </div>
      <div className="structure-kind__actions">
        {savedAt ? <span className="structure-kind__saved">Saved {formatStamp(savedAt)}</span> : null}
        <button type="button" className="prep-btn prep-btn--dark" disabled={saving} onClick={onSave}>
          <CloudUpload size={14} /> {saving ? "Saving to the cloud…" : "Save to NPL cloud"}
        </button>
      </div>
    </div>
  )
}

function TournamentStructureEditor({ block, staff, onSaved, onIdentityRefresh }: {
  block: GameStructure["tournament"]
  staff: ConsoleIdentity | null
  onSaved: (next: GameStructure) => void
  onIdentityRefresh: (identity: ConsoleIdentity) => void
}) {
  const [form, setForm] = useState<TournamentStructureSettings>(() => ({
    ...block.settings,
    rebuy_tiers: block.settings.rebuy_tiers?.length ? block.settings.rebuy_tiers : [],
    addon_tiers: block.settings.addon_tiers?.length ? block.settings.addon_tiers : [],
    chip_denominations: block.settings.chip_denominations ?? "",
    pattern: block.settings.pattern ?? DEFAULT_PATTERN,
  }))
  const [pattern, setPattern] = useState<StructurePattern>(block.settings.pattern ?? DEFAULT_PATTERN)
  const [levels, setLevels] = useState<GeneratedLevel[]>(() => renumber(block.levels ?? []))
  const [handEdited, setHandEdited] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [cutOffsOpen, setCutOffsOpen] = useState(true)
  const [localError, setLocalError] = useState<string | null>(null)
  const cloud = useCloudSave(staff, onIdentityRefresh)

  const update = <K extends keyof TournamentStructureSettings>(key: K, value: TournamentStructureSettings[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const updatePattern = <K extends keyof StructurePattern>(key: K, value: StructurePattern[K]) =>
    setPattern((current) => ({ ...current, [key]: value }))

  const generate = async () => {
    setGenerating(true)
    setLocalError(null)
    try {
      const result = await deskApi.previewStructure({ ...pattern })
      setLevels(renumber(result.levels))
      setHandEdited(false)
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "The structure could not be generated.")
    } finally {
      setGenerating(false)
    }
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

  const cutOff = (kind: CutOffKind): number | null => form[CUT_OFF_META[kind].field] as number | null

  function minutesBefore(position: number): number {
    return levels.slice(0, Math.max(0, position - 1)).reduce((sum, row) => sum + row.duration_min, 0)
  }

  function describeCutOff(kind: CutOffKind): string {
    const position = cutOff(kind)
    if (!position) return "No cut-off — open until the game finishes"

    const row = levels[position - 1]
    if (!row) return `Row ${position} — past the end of the ladder`

    const label = row.type === "break"
      ? (row.note || "Break")
      : `${row.small_blind.toLocaleString()} / ${row.big_blind.toLocaleString()}`

    return `${label} · ${minutesBefore(position)} min in`
  }

  const marks = useMemo(() => {
    const map = new Map<number, CutOffKind[]>()
    for (const kind of Object.keys(CUT_OFF_META) as CutOffKind[]) {
      const position = form[CUT_OFF_META[kind].field] as number | null
      if (!position) continue
      const list = map.get(position) ?? []
      list.push(kind)
      map.set(position, list)
    }
    return map
  }, [form])

  const totalLevels = useMemo(() => levels.filter((row) => row.type === "blind").length, [levels])
  const hasBreak = useMemo(() => levels.some((row) => row.type === "break"), [levels])
  const totalMinutes = useMemo(() => levels.reduce((sum, row) => sum + row.duration_min, 0), [levels])
  const maxBlind = useMemo(() => Math.max(0, ...levels.filter((row) => row.type === "blind").map((row) => row.big_blind)), [levels])
  const maxPosition = Math.max(1, levels.length)

  const save = () => {
    setLocalError(null)

    if (levels.length === 0) {
      setLocalError("The ladder needs at least one blind level.")
      return
    }
    if (!form.registration_closes_at_level) {
      setCutOffsOpen(true)
      setLocalError("Set the row registration closes at — everything else hangs off it.")
      return
    }
    for (const kind of Object.keys(CUT_OFF_META) as CutOffKind[]) {
      const position = cutOff(kind)
      if (position && position > levels.length) {
        setCutOffsOpen(true)
        setLocalError(`${CUT_OFF_META[kind].label} closes at row ${position}, but the ladder has ${levels.length} rows.`)
        return
      }
    }

    void cloud.save(
      (token) => deskApi.saveGameStructure({
        tournament: {
          settings: {
            ...form,
            rebuy_tiers: form.rebuy_tiers.filter((tier) => tier.chips > 0),
            addon_tiers: form.addon_tiers.filter((tier) => tier.chips > 0),
            chip_denominations: form.chip_denominations.trim(),
            pattern,
          },
          levels,
        },
      }, token),
      onSaved,
    )
  }

  const tierRows = (key: "rebuy_tiers" | "addon_tiers", label: string, fallback: AddonTier) => (
    <>
      {form[key].map((tier, index) => (
        <div className="prep-field-grid prep-tier-row" key={index}>
          <div className="prep-field">
            <label>Tier {index + 1} price ($)</label>
            <input
              type="number" min={0} value={tier.price_cents / 100}
              onChange={(e) => update(key, form[key].map((row, i) =>
                i === index ? { ...row, price_cents: Math.round(Number(e.target.value) * 100) } : row))}
            />
          </div>
          <div className="prep-field">
            <label>Chips</label>
            <input
              type="number" min={0} value={tier.chips}
              onChange={(e) => update(key, form[key].map((row, i) =>
                i === index ? { ...row, chips: Number(e.target.value) } : row))}
            />
          </div>
          <div className="prep-field prep-tier-row__remove">
            <label>&nbsp;</label>
            <button
              type="button"
              className="prep-tier-remove"
              onClick={() => update(key, form[key].filter((_, i) => i !== index))}
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
            disabled={form[key].length >= 4}
            onClick={() => {
              const last = form[key][form[key].length - 1]
              update(key, [...form[key], last
                ? { price_cents: last.price_cents * 2, chips: last.chips * 2 }
                : fallback])
            }}
          >
            + Add {label} tier
          </button>
          {form[key].length === 0 ? <small>No tiers — {label}s are off.</small> : null}
        </div>
        <div className="prep-field">
          <label>Max {label}s per player</label>
          <input
            type="number" min={0} max={255}
            value={key === "rebuy_tiers" ? form.max_rebuys_per_player : form.max_addons_per_player}
            onChange={(e) => update(key === "rebuy_tiers" ? "max_rebuys_per_player" : "max_addons_per_player", Number(e.target.value))}
          />
          <small>{key === "rebuy_tiers" ? "0 = unlimited · counts across all tiers" : "Counts across all tiers."}</small>
        </div>
      </div>
    </>
  )

  return (
    <section className="structure-kind" aria-label="Tournament defaults">
      <KindHeader
        title="Tournament desk"
        hint="Daily games, Special Events and Main Event flights opened in tournament mode"
        block={block}
        saving={cloud.saving}
        savedAt={cloud.savedAt}
        onSave={save}
      />

      <div className="prep-summary">
        <Chip label="Buy-in" value={money(form.buy_in_price_cents)} />
        <Chip label="Stack" value={form.starting_stack.toLocaleString()} />
        <Chip label="Seats" value={String(form.seats_per_table)} />
        <Chip label={form.rebuy_tiers.length > 1 ? "Rebuys" : "Rebuy"} value={form.rebuy_tiers.length ? form.rebuy_tiers.map((tier) => money(tier.price_cents)).join(" / ") : "—"} />
        <Chip label={form.addon_tiers.length > 1 ? "Add-ons" : "Add-on"} value={form.addon_tiers.length ? form.addon_tiers.map((tier) => money(tier.price_cents)).join(" / ") : "—"} />
        {form.jackpot_enabled ? <Chip label="Jackpot" value={money(form.jackpot_price_cents)} /> : null}
        <Chip label="Levels" value={`${totalLevels}${hasBreak ? " + Break" : ""}`} />
        <Chip label="Max blind" value={maxBlind ? maxBlind.toLocaleString() : "—"} />
        <Chip label="Length" value={`${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`} />
        <Chip label="Reg closes" value={form.registration_closes_at_level ? `Row ${form.registration_closes_at_level}` : "—"} />
      </div>

      {localError ? <div className="prep-error" role="alert">{localError}</div> : null}
      {cloud.error ? <div className="prep-error" role="alert">{cloud.error}</div> : null}

      <div className="prep-grid">
        <div className="prep-main">
          <section className="prep-card">
            <div className="prep-card__head">
              <div className="prep-card__title">Tournament Settings</div>
            </div>
            <div className="prep-card__body">
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
              <div className="prep-subhead">Rebuys — up to four tiers, right-click a player at the desk for the fast rebuy</div>
              {tierRows("rebuy_tiers", "rebuy", { price_cents: 10000, chips: 20000 })}

              <div className="prep-divider" />

              <div className="prep-subhead">Add-ons — up to four tiers, the desk offers one button per tier</div>
              {tierRows("addon_tiers", "add-on", { price_cents: 5000, chips: 30000 })}
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
                Run the jackpot at tournaments
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
                          value={cutOff(kind) ?? ""}
                          placeholder="None"
                          onChange={(e) => update(
                            CUT_OFF_META[kind].field,
                            (e.target.value === "" ? (kind === "registration" ? 0 : null) : Number(e.target.value)) as never,
                          )}
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
                        No levels. Add at least one blind level, or fill the ladder from a pattern.
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
                    type="number" min={1} value={pattern.ante_from_level ?? ""}
                    placeholder="None"
                    onChange={(e) => updatePattern("ante_from_level", e.target.value === "" ? null : Number(e.target.value))}
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

      {cloud.dialog}
    </section>
  )
}

function CashStructureEditor({ block, staff, onSaved, onIdentityRefresh }: {
  block: GameStructure["cash"]
  staff: ConsoleIdentity | null
  onSaved: (next: GameStructure) => void
  onIdentityRefresh: (identity: ConsoleIdentity) => void
}) {
  const [form, setForm] = useState<CashStructureSettings>(() => ({ ...block.settings }))
  const cloud = useCloudSave(staff, onIdentityRefresh)

  function set<K extends keyof CashStructureSettings>(key: K, value: CashStructureSettings[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const dollars = (cents: number) => (cents / 100).toFixed(0)

  const save = () => {
    void cloud.save(
      (token) => deskApi.saveGameStructure({ cash: { settings: form } }, token),
      onSaved,
    )
  }

  return (
    <section className="structure-kind" aria-label="Cash game defaults">
      <KindHeader
        title="Cash game desk"
        hint="Cash games, and events opened in cash game mode — no clock, no ladder, cut-offs by time"
        block={block}
        saving={cloud.saving}
        savedAt={cloud.savedAt}
        onSave={save}
      />

      {cloud.error ? <div className="prep-error" role="alert">{cloud.error}</div> : null}

      <div className="prep-grid">
        <div className="prep-main">
          <section className="prep-card">
            <div className="prep-card__head">
              <div className="prep-card__title">Cash Game Settings</div>
            </div>
            <div className="prep-card__body">
              <div className="prep-field-grid">
                <div className="prep-field">
                  <label>Buy-in ($)</label>
                  <input
                    type="number" min={0}
                    value={dollars(form.buy_in_price_cents)}
                    onChange={(event) => set("buy_in_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
                  />
                </div>
                <div className="prep-field">
                  <label>Chips handed</label>
                  <input
                    type="number" min={1}
                    value={form.starting_stack}
                    onChange={(event) => set("starting_stack", Math.max(1, Number(event.target.value) || 1))}
                  />
                </div>
                <div className="prep-field">
                  <label>Seats per table</label>
                  <input
                    type="number" min={2} max={10}
                    value={form.seats_per_table}
                    onChange={(event) => set("seats_per_table", Math.min(10, Math.max(2, Number(event.target.value) || 8)))}
                  />
                </div>
              </div>

              <label className="prep-check">
                <input
                  type="checkbox"
                  checked={form.topups_enabled}
                  onChange={(event) => set("topups_enabled", event.target.checked)}
                />
                Top-ups allowed (rebuy)
              </label>
              {form.topups_enabled ? (
                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Top-up ($)</label>
                    <input
                      type="number" min={0}
                      value={dollars(form.rebuy_price_cents)}
                      onChange={(event) => set("rebuy_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
                    />
                  </div>
                  <div className="prep-field">
                    <label>Top-up chips</label>
                    <input
                      type="number" min={1}
                      value={form.rebuy_chips}
                      onChange={(event) => set("rebuy_chips", Math.max(1, Number(event.target.value) || 1))}
                    />
                  </div>
                </div>
              ) : null}

              <div className="prep-divider" />

              <label className="prep-check">
                <input
                  type="checkbox"
                  checked={form.jackpot_enabled}
                  onChange={(event) => set("jackpot_enabled", event.target.checked)}
                />
                Jackpot side pool
              </label>
              {form.jackpot_enabled ? (
                <div className="prep-field-grid">
                  <div className="prep-field">
                    <label>Jackpot entry ($)</label>
                    <input
                      type="number" min={0}
                      value={dollars(form.jackpot_price_cents)}
                      onChange={(event) => set("jackpot_price_cents", Math.max(0, Number(event.target.value) || 0) * 100)}
                    />
                  </div>
                </div>
              ) : null}

              <div className="prep-divider" />

              <div className="prep-field-grid">
                <div className="prep-field">
                  <label>Registration closes (min after start, 0 = never)</label>
                  <input
                    type="number" min={0} max={1440}
                    value={form.cash_reg_close_min}
                    onChange={(event) => set("cash_reg_close_min", Math.max(0, Math.min(1440, Number(event.target.value) || 0)))}
                  />
                </div>
                {form.jackpot_enabled ? (
                  <div className="prep-field">
                    <label>Jackpot closes (min after start, 0 = never)</label>
                    <input
                      type="number" min={0} max={1440}
                      value={form.cash_jackpot_close_min}
                      onChange={(event) => set("cash_jackpot_close_min", Math.max(0, Math.min(1440, Number(event.target.value) || 0)))}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>

      {cloud.dialog}
    </section>
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
