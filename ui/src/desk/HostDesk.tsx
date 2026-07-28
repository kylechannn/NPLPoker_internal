import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, Loader2, RotateCcw, ScanLine, Undo2 } from "lucide-react"
import {
  countdown,
  deskApi,
  money,
  type DeskOption,
  type Gates,
  type ScanResult,
  type SeatedPlayer,
  type Seating,
} from "./deskApi"

type Props = {
  sessionId: number
  onExit: () => void
}

type SeatMenu = {
  x: number
  y: number
  player: SeatedPlayer
}

const GATE_LABELS: Array<{ key: keyof Gates, label: string }> = [
  { key: "registration", label: "Registration" },
  { key: "rebuy", label: "Rebuys" },
  { key: "addon", label: "Add-ons" },
  { key: "jackpot", label: "Jackpot" },
]

/**
 * The live desk.
 *
 * The scan box holds focus at all times: a player can walk up at any moment,
 * and an operator should never have to click into a field first. Every other
 * control returns focus to it once it is done.
 */
export default function HostDesk({ sessionId, onExit }: Props) {
  const scanRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [seating, setSeating] = useState<Seating | null>(null)
  const [menu, setMenu] = useState<SeatMenu | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const focusScan = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0)
  }, [])

  const refresh = useCallback(async () => {
    try {
      setSeating(await deskApi.seating(sessionId))
    } catch (e) {
      setError(e instanceof Error ? e.message : "The seating map could not be loaded.")
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    focusScan()
  }, [refresh, focusScan])

  // Keeps the cut-off countdowns honest without hammering the API — the
  // clock itself is authoritative, this only re-reads it every few seconds.
  useEffect(() => {
    const handle = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(handle)
  }, [refresh])

  useEffect(() => {
    if (!flash) return
    const handle = window.setTimeout(() => setFlash(null), 2500)
    return () => window.clearTimeout(handle)
  }, [flash])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [menu])

  async function submitScan(raw: string) {
    const id = raw.trim()
    if (!id) return

    setBusy(true)
    setError(null)

    try {
      setScan(await deskApi.scan(sessionId, id))
      setValue("")
    } catch (e) {
      setScan(null)
      setError(e instanceof Error ? e.message : "That scan could not be read.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  async function runAction(option: DeskOption) {
    if (!scan || !option.allowed) return

    setBusy(true)
    setError(null)

    try {
      const result = await deskApi.act(sessionId, scan.player.npl_id, option.action)
      setSeating(result.seating)
      setFlash(`${option.label} taken for ${scan.player.display_name}${option.price_cents ? ` — ${money(option.price_cents)}` : ""}`)
      // Re-scan so the buttons reflect what is left (caps, jackpot already in).
      setScan(await deskApi.scan(sessionId, scan.player.npl_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "That action could not be applied.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  async function seatAction(fn: () => Promise<Seating>, message: string) {
    setBusy(true)
    setError(null)
    setMenu(null)

    try {
      setSeating(await fn())
      setFlash(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : "That change could not be applied.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  const gates = seating?.gates

  return (
    <div className="host-desk">
      <header className="host-desk__scan">
        <label className="host-desk__scanbox">
          <ScanLine size={18} />
          <input
            ref={scanRef}
            value={value}
            autoFocus
            placeholder="Scan a player card or type an NPL ID, then Enter"
            aria-label="Scan a player"
            onChange={(e) => setValue(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void submitScan(value)
              }
            }}
          />
          {busy ? <Loader2 size={16} className="host-spin" /> : null}
        </label>

        <div className="host-desk__gates">
          {GATE_LABELS.map(({ key, label }) => {
            const gate = gates?.[key]
            if (!gate) return null
            return (
              <span key={key} className={gate.open ? "host-gate host-gate--open" : "host-gate host-gate--shut"}>
                <strong>{label}</strong>
                {gate.open
                  ? (gate.closes_in_ms === null ? "open" : `closes in ${countdown(gate.closes_in_ms)}`)
                  : "closed"}
              </span>
            )
          })}
        </div>

        <button className="host-desk__exit" type="button" onClick={onExit}>Preset</button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}
      {flash ? <p className="host-desk__flash" role="status">{flash}</p> : null}

      <div className="host-desk__body">
        <section className="host-desk__player">
          {scan ? (
            <>
              <div className="host-desk__identity">
                {scan.player.avatar_url
                  ? <img src={scan.player.avatar_url} alt="" />
                  : <span>{scan.player.display_name.slice(0, 2).toUpperCase()}</span>}
                <div>
                  <strong>{scan.player.display_name}</strong>
                  <small>{scan.player.npl_id}{scan.player.state_code ? ` · ${scan.player.state_code}` : ""}</small>
                </div>
              </div>

              {scan.entry ? (
                <dl className="host-desk__entrystats">
                  <div><dt>Seat</dt><dd>{scan.entry.table_number ? `T${scan.entry.table_number} S${scan.entry.seat_number}` : "Unseated"}</dd></div>
                  <div><dt>Rebuys</dt><dd>{scan.entry.rebuys}{scan.entry.max_rebuys ? ` / ${scan.entry.max_rebuys}` : ""}</dd></div>
                  <div><dt>Add-ons</dt><dd>{scan.entry.addons} / {scan.entry.max_addons}</dd></div>
                  <div><dt>Spent</dt><dd>{money(scan.entry.spend_cents)}</dd></div>
                </dl>
              ) : (
                <p className="host-desk__new">Not in this tournament yet.</p>
              )}

              <div className="host-desk__actions">
                {scan.options.map((option) => (
                  <button
                    key={option.action}
                    type="button"
                    className={option.allowed ? "host-action" : "host-action host-action--blocked"}
                    disabled={!option.allowed || busy}
                    title={option.reason ?? undefined}
                    onClick={() => void runAction(option)}
                  >
                    <strong>{option.label}</strong>
                    <span>{option.price_cents ? money(option.price_cents) : "Free"}</span>
                    {option.reason ? <em>{option.reason}</em> : null}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="host-desk__idle">Scan a card to begin.</p>
          )}

          {seating ? (
            <dl className="host-desk__counts">
              <div><dt>In play</dt><dd>{seating.counts.active}</dd></div>
              <div><dt>Entries</dt><dd>{seating.counts.entries}</dd></div>
              <div><dt>Out</dt><dd>{seating.counts.eliminated}</dd></div>
              <div><dt>Jackpot</dt><dd>{seating.counts.in_jackpot}</dd></div>
            </dl>
          ) : null}
        </section>

        <section className="host-desk__tables">
          {seating?.unseated.length ? (
            <div className="host-desk__pool">
              <h4>Waiting to be seated</h4>
              <div>
                {seating.unseated.map((player) => (
                  <button
                    key={player.npl_id}
                    type="button"
                    className="host-chip"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, player })
                    }}
                  >
                    {player.display_name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="host-desk__grid">
            {seating?.tables.map((table) => (
              <article key={table.table_number} className="host-table">
                <header>
                  <strong>Table {table.table_number}</strong>
                  <span>{table.occupied} / {seating.seats_per_table}</span>
                </header>
                <ul>
                  {table.seats.map((seat) => (
                    <li key={seat.seat_number}
                      className={seat.player ? "host-seat host-seat--taken" : "host-seat"}
                      onContextMenu={(e) => {
                        if (!seat.player) return
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, player: seat.player })
                      }}
                    >
                      <span className="host-seat__no">{seat.seat_number}</span>
                      {seat.player ? (
                        <span className="host-seat__name">
                          {seat.player.display_name}
                          {seat.player.in_jackpot ? <em title="In the jackpot">★</em> : null}
                        </span>
                      ) : (
                        <span className="host-seat__open">Open</span>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>

          {seating?.eliminated.length ? (
            <div className="host-desk__out">
              <h4>Eliminated</h4>
              <ol>
                {seating.eliminated.map((player) => (
                  <li key={player.npl_id}>
                    <span>{player.finish_position ? `#${player.finish_position}` : "—"}</span>
                    <strong>{player.display_name}</strong>
                    <button type="button" onClick={() => void seatAction(
                      () => deskApi.reinstate(sessionId, player.npl_id),
                      `${player.display_name} is back in.`,
                    )}>
                      <Undo2 size={13} /> Undo
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      </div>

      {menu ? (
        <div className="host-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <p>{menu.player.display_name}</p>
          <button type="button" onClick={() => void seatAction(
            async () => {
              await deskApi.act(sessionId, menu.player.npl_id, "rebuy")
              return deskApi.seating(sessionId)
            },
            `Rebuy taken for ${menu.player.display_name}.`,
          )}>
            <RotateCcw size={14} /> Rebuy
          </button>
          <button type="button" className="host-menu__danger" onClick={() => void seatAction(
            () => deskApi.eliminate(sessionId, menu.player.npl_id),
            `${menu.player.display_name} is out.`,
          )}>
            <Ban size={14} /> Eliminate
          </button>
          {menu.player.table_number ? (
            <button type="button" onClick={() => void seatAction(
              () => deskApi.seat(sessionId, menu.player.npl_id, null, null),
              `${menu.player.display_name} moved to the waiting pool.`,
            )}>
              Unseat
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
