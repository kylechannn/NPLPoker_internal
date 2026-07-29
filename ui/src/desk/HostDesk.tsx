import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, Loader2, MonitorPlay, RotateCcw, ScanLine, Ticket, Undo2 } from "lucide-react"
import { notify } from "../notifications/store"
import {
  countdown,
  deskApi,
  money,
  type DeskOption,
  type DeskVoucher,
  type Gates,
  type ScanResult,
  type SeatedPlayer,
  type Seating,
} from "./deskApi"

function activeVenueId(): number | null {
  const stored = window.localStorage.getItem("npl.activeVenueId")
  return stored ? Number(stored) || null : null
}

type Props = {
  sessionId: number
  onExit: () => void
  /** Reports the clock status upward so the workspace stepper can follow. */
  onClockStatus?: (status: string) => void
  /** Moves to the Finishing step (top-10 entry). */
  onFinishGame?: () => void
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
function optionKey(option: DeskOption): string {
  return `${option.action}:${option.tier ?? "-"}`
}

export default function HostDesk({ sessionId, onExit, onClockStatus, onFinishGame }: Props) {
  const scanRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [seating, setSeating] = useState<Seating | null>(null)
  const [menu, setMenu] = useState<SeatMenu | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [voucher, setVoucher] = useState<DeskVoucher | null>(null)
  // The redeem reference survives a failed attempt so retrying is safe.
  const voucherRefRef = useRef<string | null>(null)
  // The scan popup's ticked actions, keyed action:tier. One submit fires
  // them all, buy-in always first.
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const focusScan = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await deskApi.seating(sessionId)
      setSeating(next)
      const status = (next.clock as { status?: string } | undefined)?.status
      if (status) onClockStatus?.(status)
    } catch (e) {
      setError(e instanceof Error ? e.message : "The seating map could not be loaded.")
    }
  }, [sessionId, onClockStatus])

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
    setVoucher(null)
    voucherRefRef.current = null

    try {
      const result = await deskApi.scan(sessionId, id)
      setScan(result)
      setValue("")

      // Buy-in is the essential first action for a player not in yet —
      // pre-ticked so the common case is scan → Submit.
      const buyIn = result.options.find((option) => option.action === "buy_in" && option.allowed)
      setPicked(!result.entry && buyIn ? new Set([optionKey(buyIn)]) : new Set())

      // Free-entry check happens after the scan lands, without blocking it:
      // the prompt appears a beat later only for unregistered players.
      if (!result.entry) {
        void checkVoucher(result.player.npl_id)
      }
    } catch (e) {
      setScan(null)
      setError(e instanceof Error ? e.message : "That scan could not be read.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  async function checkVoucher(nplId: string) {
    try {
      const check = await deskApi.voucherEntitlement(nplId, activeVenueId())
      setVoucher((current) => (current === null && check.entitled ? check.voucher : current))
    } catch {
      // No prompt on failure — the normal fee flow is never blocked.
    }
  }

  /**
   * One tap: redeem the voucher in the cloud (idempotent by reference, so a
   * retry after a dropped connection can never consume twice), then book
   * the buy-in locally at zero with the code on the action.
   */
  async function applyVoucher() {
    if (!scan || !voucher || busy) return

    setBusy(true)
    setError(null)
    voucherRefRef.current ??= `DV-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`

    try {
      await deskApi.voucherRedeem(voucherRefRef.current, scan.player.npl_id, voucher.id, activeVenueId())
      const result = await deskApi.act(sessionId, scan.player.npl_id, "buy_in", { voucher_code: voucher.code })
      voucherRefRef.current = null
      setSeating(result.seating)
      setFlash(`FREE entry for ${scan.player.display_name} — voucher ${voucher.code} applied.`)
      notify("registration", `${scan.player.display_name} — desk`, `Free entry, voucher ${voucher.code} applied.`, "success")
      setVoucher(null)
      setScan(await deskApi.scan(sessionId, scan.player.npl_id))
    } catch (e) {
      // The kept reference makes pressing the button again a safe retry.
      setError(e instanceof Error ? e.message : "The voucher could not be applied.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  function toggleOption(option: DeskOption) {
    if (!scan || !option.allowed) return

    const key = optionKey(option)
    const registered = scan.entry !== null

    setPicked((current) => {
      const next = new Set(current)

      if (next.has(key)) {
        next.delete(key)
        // Buy-in is the foundation: unticking it drops everything that
        // depends on the player actually being in the game.
        if (option.action === "buy_in") {
          next.clear()
        }
      } else {
        next.add(key)
        // Ticking anything for an unregistered player implies the buy-in.
        if (!registered && option.action !== "buy_in") {
          const buyIn = scan.options.find((o) => o.action === "buy_in" && o.allowed)
          if (buyIn) next.add(optionKey(buyIn))
        }
      }

      return next
    })
  }

  /** Fire every ticked action in dependency order — buy-in always first. */
  async function submitActions() {
    if (!scan || picked.size === 0 || busy) return

    const order: Record<string, number> = { buy_in: 0, rebuy: 1, addon: 2, jackpot: 3 }
    const chosen = scan.options
      .filter((option) => option.allowed && picked.has(optionKey(option)))
      .sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9))

    if (chosen.length === 0) return

    setBusy(true)
    setError(null)

    const applied: string[] = []
    let total = 0

    try {
      for (const option of chosen) {
        const result = await deskApi.act(
          sessionId,
          scan.player.npl_id,
          option.action,
          option.tier !== undefined ? { tier: option.tier } : {},
        )
        setSeating(result.seating)
        applied.push(option.label)
        total += option.price_cents
      }

      setFlash(`${scan.player.display_name}: ${applied.join(" + ")} — ${money(total)} collected.`)
      notify(
        "registration",
        `${scan.player.display_name} — desk`,
        `${applied.join(" + ")} · ${money(total)} collected.`,
        "success",
      )
      setScan(null)
      setPicked(new Set())
      setVoucher(null)
    } catch (e) {
      // Whatever landed before the failure is real: re-scan so the popup
      // shows the true remaining state, and name what got through.
      setError(`${e instanceof Error ? e.message : "An action failed."}${applied.length ? ` (Already applied: ${applied.join(", ")}.)` : ""}`)
      try {
        const fresh = await deskApi.scan(sessionId, scan.player.npl_id)
        setScan(fresh)
        setPicked(new Set())
      } catch {
        // Keep the stale popup rather than losing the error message.
      }
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

        <button
          className="host-desk__display"
          type="button"
          title="Open the room clock in its own window"
          onClick={() => {
            // A real window, not a tab: it gets dragged onto the projector and
            // left there. The clock is server-authoritative, so opening two of
            // these can never make them disagree.
            window.open(
              `${window.location.pathname}?display=timer&session=${sessionId}`,
              `npl-timer-${sessionId}`,
              "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
            )
          }}
        >
          <MonitorPlay size={15} /> Room clock
        </button>

        {onFinishGame ? (
          <button className="host-desk__finish" type="button" onClick={onFinishGame}>Finish game</button>
        ) : null}
        <button className="host-desk__exit" type="button" onClick={onExit}>Preset</button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}
      {flash ? <p className="host-desk__flash" role="status">{flash}</p> : null}

      {scan ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => { if (!busy) { setScan(null); setVoucher(null); focusScan() } }}>
          <section
            className="host-scan-modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={`Actions for ${scan.player.display_name}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
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
              <p className="host-desk__new">Not in this tournament yet — buy-in seats them automatically.</p>
            )}

            {scan.booking && !scan.entry ? (
              <p className="host-booking-banner">
                {scan.booking.status === "waitlisted"
                  ? `Booked online — wait list #${scan.booking.waitlist_position ?? "?"} on table ${scan.booking.table_number}. Buy-in confirms their entry.`
                  : scan.booking.seat_number !== null
                    ? `Booked online — table ${scan.booking.table_number}, seat ${scan.booking.seat_number}. Buy-in confirms their entry.`
                    : `Booked online — table ${scan.booking.table_number}. Buy-in confirms their entry.`}
              </p>
            ) : null}

            {voucher && !scan.entry && scan.options.some((option) => option.action === "buy_in" && option.allowed) ? (
              <button
                className="host-voucher-banner"
                type="button"
                disabled={busy}
                onClick={() => void applyVoucher()}
              >
                <Ticket size={18} />
                <span>
                  <strong>FREE ENTRY — {voucher.title || "entry voucher"}</strong>
                  <small>
                    {voucher.code}
                    {voucher.unlimited_uses
                      ? " · pass active"
                      : voucher.uses_remaining !== null
                        ? ` · ${voucher.uses_remaining} use${voucher.uses_remaining === 1 ? "" : "s"} left`
                        : ""}
                    {" — tap to apply the free Buy-in now"}
                  </small>
                </span>
              </button>
            ) : null}

            <div className="host-scan-modal__options" role="group" aria-label="Tick the actions to take">
              {scan.options.map((option) => {
                const key = optionKey(option)
                const ticked = picked.has(key)
                return (
                  <label
                    key={key}
                    className={
                      option.allowed
                        ? ticked ? "host-tick host-tick--on" : "host-tick"
                        : "host-tick host-tick--blocked"
                    }
                    title={option.reason ?? undefined}
                  >
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={!option.allowed || busy}
                      onChange={() => toggleOption(option)}
                    />
                    <strong>{option.label}</strong>
                    <span>{option.price_cents ? money(option.price_cents) : "Free"}</span>
                    {option.reason ? <em>{option.reason}</em> : null}
                  </label>
                )
              })}
            </div>

            <footer className="host-scan-modal__footer">
              <div className="host-scan-modal__total">
                Total
                <strong>
                  {money(scan.options
                    .filter((option) => option.allowed && picked.has(optionKey(option)))
                    .reduce((sum, option) => sum + option.price_cents, 0))}
                </strong>
              </div>
              <button
                type="button"
                className="host-scan-modal__cancel"
                disabled={busy}
                onClick={() => { setScan(null); setVoucher(null); focusScan() }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="host-scan-modal__submit"
                disabled={busy || picked.size === 0}
                onClick={() => void submitActions()}
              >
                {busy ? "Applying…" : `Submit${picked.size ? ` (${picked.size})` : ""}`}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="host-desk__body">
        <section className="host-desk__player">
          <p className="host-desk__idle">Scan a card to begin.</p>

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

            <button
              type="button"
              className="host-table host-table--add"
              disabled={busy}
              onClick={() => void seatAction(
                () => deskApi.createTable(sessionId).then((result) => result.seating),
                "New table opened — online seat maps updated.",
              )}
            >
              + Add table
            </button>
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
