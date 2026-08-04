import { useCallback, useEffect, useRef, useState } from "react"
import { Ban, Clock3, Loader2, MessageSquareWarning, MonitorPlay, Play, RotateCcw, ScanLine, Ticket, Undo2, X } from "lucide-react"
import { notify } from "../notifications/store"
import { playersApi, type PlayerComment, type RosterPlayer } from "../players/playersApi"
import {
  countdown,
  deskApi,
  money,
  type DeskOption,
  type DeskVoucher, type OnlineCoverage,
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
  /** 'cash' = no clock, no add-ons, and vouchers never apply. */
  mode?: "tournament" | "cash"
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

/** The slice of the clock snapshot the cash timer needs. */
type CashClockState = {
  status?: string
  running?: boolean
  level_duration_ms?: number
  remaining_ms?: number
  server_time_ms?: number
}

/**
 * The cash game's timer: pure elapsed play, no blinds, no levels. The
 * snapshot is server-authoritative (elapsed = level duration − remaining);
 * between the 5s refreshes it ticks locally while the game runs. The local
 * backend lives on this same machine, so its clock IS our clock.
 */
function CashTimer({ clock, status }: { clock: CashClockState | undefined, status: string | null }) {
  const [, forceTick] = useState(0)

  useEffect(() => {
    const handle = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => window.clearInterval(handle)
  }, [])

  if (!clock) return null

  const base = Math.max(0, (clock.level_duration_ms ?? 0) - (clock.remaining_ms ?? 0))
  const drift = clock.running && clock.server_time_ms ? Math.max(0, Date.now() - clock.server_time_ms) : 0
  const total = Math.floor((base + drift) / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")

  return (
    <span className={status === "finished" ? "host-cash-timer host-cash-timer--done" : "host-cash-timer"} aria-label="Cash game timer">
      <Clock3 size={14} />
      <strong>{pad(hours)}:{pad(minutes)}:{pad(seconds)}</strong>
      <small>{status === "finished" ? "FINISHED" : status === "paused" ? "PAUSED" : "PLAYING"}</small>
    </span>
  )
}

export default function HostDesk({ sessionId, onExit, onClockStatus, onFinishGame, mode = "tournament" }: Props) {
  const scanRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState("")
  const [scan, setScan] = useState<ScanResult | null>(null)
  // Staff comments gating the scan popup until acknowledged.
  const [scanComments, setScanComments] = useState<{ nplId: string, seenKey: string, comments: PlayerComment[] } | null>(null)
  const seenCommentsRef = useRef<Set<string>>(new Set())
  const [seating, setSeating] = useState<Seating | null>(null)
  const [menu, setMenu] = useState<SeatMenu | null>(null)
  const [tableMenu, setTableMenu] = useState<{ x: number, y: number, tableNumber: number } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [removeCandidate, setRemoveCandidate] = useState<SeatedPlayer | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [voucher, setVoucher] = useState<DeskVoucher | null>(null)
  // The entry was ALREADY paid online with a voucher: price the buy-in at
  // the difference only, and never redeem anything at the desk.
  const [coveredOnline, setCoveredOnline] = useState<OnlineCoverage | null>(null)
  // The pre-popup question: a free-entry voucher was detected on scan and
  // the operator has not answered yet. The registration popup waits.
  const [voucherAsk, setVoucherAsk] = useState<{ result: ScanResult, voucher: DeskVoucher } | null>(null)
  // Yes was answered: this scan's buy-in is covered — shown at $0.
  const [useVoucher, setUseVoucher] = useState(false)
  const [clockStatus, setClockStatus] = useState<string>("draft")
  // The redeem reference survives a failed attempt so retrying is safe.
  const voucherRefRef = useRef<string | null>(null)
  // The scan popup's ticked actions, keyed action:tier. One submit fires
  // them all, buy-in always first.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Roster matches for whatever is typed in the scan box — the desk can
  // find and register a player by name as well as by card or NPL ID.
  const [nameHits, setNameHits] = useState<RosterPlayer[]>([])

  const focusScan = useCallback(() => {
    window.setTimeout(() => scanRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    const term = value.trim()

    if (term.length < 3) {
      setNameHits([])
      return
    }

    let cancelled = false
    const handle = window.setTimeout(() => {
      void playersApi
        .search(term, null)
        .then((result) => {
          if (!cancelled) setNameHits((result.players ?? []).slice(0, 8))
        })
        .catch(() => {
          if (!cancelled) setNameHits([])
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [value])

  const refresh = useCallback(async () => {
    try {
      const next = await deskApi.seating(sessionId)
      setSeating(next)
      const status = (next.clock as { status?: string } | undefined)?.status
      if (status) {
        setClockStatus(status)
        onClockStatus?.(status)
      }
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
    if (!menu && !tableMenu) return
    const close = () => {
      setMenu(null)
      setTableMenu(null)
    }
    window.addEventListener("click", close)
    return () => window.removeEventListener("click", close)
  }, [menu, tableMenu])

  async function submitScan(raw: string) {
    const id = raw.trim()
    if (!id) return

    setBusy(true)
    setError(null)
    setVoucher(null)
    setCoveredOnline(null)
    voucherRefRef.current = null

    try {
      const result = await deskApi.scan(sessionId, id)
      setValue("")

      // Free entry comes FIRST: for a player not yet in the tournament,
      // the voucher question appears BEFORE the registration popup. Only
      // a clear "entitled" answer asks — offline or no voucher goes
      // straight to the normal popup. Never for cash games.
      if (!result.entry && mode !== "cash") {
        try {
          const check = await deskApi.voucherEntitlement(
            result.player.npl_id,
            activeVenueId(),
            seating?.game_session_id ?? null,
          )
          // Paid online already — no question to ask: open the popup with
          // the buy-in priced at the covered rate, redeem NOTHING here.
          if (check.already_covered) {
            setCoveredOnline(check.already_covered)
            openActions(result, false)
            return
          }
          if (check.entitled && check.voucher) {
            setVoucherAsk({ result, voucher: check.voucher })
            return
          }
        } catch {
          // No answer = no question; the normal fee flow is never blocked.
        }
      }

      openActions(result, false)
    } catch (e) {
      setScan(null)
      setError(e instanceof Error ? e.message : "That scan could not be read.")
    } finally {
      setBusy(false)
      focusScan()
    }
  }

  /** Opens the registration popup — with the buy-in covered, or not. */
  function openActions(result: ScanResult, withVoucher: boolean) {
    setUseVoucher(withVoucher)
    setScan(result)

    // Buy-in is the essential first action for a player not in yet —
    // pre-ticked so the common case is scan → Submit.
    const buyIn = result.options.find((option) => option.action === "buy_in" && option.allowed)
    setPicked(!result.entry && buyIn ? new Set([optionKey(buyIn)]) : new Set())

    // Staff comments surface on the FIRST registration scan only, and
    // once acknowledged the same player never re-prompts this session
    // (mahjong-style). Fetch is async and fail-open — offline just
    // means no popup, never a blocked scan.
    setScanComments(null)
    if (!result.entry) {
      void playersApi.comments(result.player.npl_id)
        .then((comments) => {
          const seenKey = `${sessionId}:${result.player.npl_id}:${comments.comments[0]?.id ?? 0}`
          if (comments.available && comments.comments.length > 0 && !seenCommentsRef.current.has(seenKey)) {
            setScanComments({ nplId: result.player.npl_id, seenKey, comments: comments.comments })
          }
        })
        .catch(() => undefined)
    }
  }

  /**
   * The part of a buy-in the voucher does NOT cover. A voucher with an
   * entry-fee limit covers buy-ins up to that limit in full; for dearer
   * games the player pays the difference. No limit = fully covered.
   */
  function voucherDeficitCents(candidate: DeskVoucher, buyInCents: number): number {
    const limit = candidate.entry_fee_limit_cents ?? null
    if (limit === null) return 0
    return Math.max(0, buyInCents - limit)
  }

  /** Same maths for an online-covered entry: limit covers, rest is owed. */
  function coveredDeficitCents(coverage: OnlineCoverage, buyInCents: number): number {
    const limit = coverage.entry_fee_limit_cents ?? null
    if (limit === null) return 0
    return Math.max(0, buyInCents - limit)
  }

  /** What this option actually charges — the accepted voucher covers buy-in
   *  up to its limit; anything above is still collected. */
  function priceFor(option: DeskOption): number {
    if (option.action === "buy_in" && coveredOnline) {
      return coveredDeficitCents(coveredOnline, option.price_cents)
    }
    if (useVoucher && voucher && option.action === "buy_in") {
      return voucherDeficitCents(voucher, option.price_cents)
    }
    return option.price_cents
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

    // Cash rule: the jackpot may only ride the SAME submit as the first
    // buy-in — this flag is the server's proof the pair belong together.
    const jackpotWithBuyIn = chosen.some((option) => option.action === "buy_in")

    setBusy(true)
    setError(null)

    const applied: string[] = []
    let total = 0

    try {
      for (const option of chosen) {
        // Paid ONLINE already: the voucher was consumed at registration —
        // book the entry at the covered price with the code on the action,
        // and redeem nothing (a second redemption would double-spend).
        if (option.action === "buy_in" && coveredOnline) {
          const deficit = coveredDeficitCents(coveredOnline, option.price_cents)
          const result = await deskApi.act(sessionId, scan.player.npl_id, "buy_in", {
            voucher_code: coveredOnline.code,
            voucher_limit_cents: coveredOnline.entry_fee_limit_cents ?? null,
          })
          setSeating(result.seating)
          applied.push(deficit > 0
            ? `Buy-in (paid online with ${coveredOnline.code} + ${money(deficit)} difference)`
            : `Buy-in (paid online — voucher ${coveredOnline.code})`)
          total += deficit
          continue
        }

        // A voucher-covered buy-in redeems on the cloud FIRST (idempotent
        // by reference — a retry can never consume twice), then books the
        // entry locally at zero with the code on the action.
        if (option.action === "buy_in" && useVoucher && voucher) {
          const deficit = voucherDeficitCents(voucher, option.price_cents)
          voucherRefRef.current ??= `DV-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`
          await deskApi.voucherRedeem(voucherRefRef.current, scan.player.npl_id, voucher.id, activeVenueId(), seating?.game_session_id ?? null)
          const result = await deskApi.act(sessionId, scan.player.npl_id, "buy_in", {
            voucher_code: voucher.code,
            voucher_limit_cents: voucher.entry_fee_limit_cents ?? null,
          })
          voucherRefRef.current = null
          setSeating(result.seating)
          applied.push(deficit > 0
            ? `Buy-in (voucher ${voucher.code} + ${money(deficit)} difference)`
            : `Buy-in (FREE — voucher ${voucher.code})`)
          total += deficit
          continue
        }

        const result = await deskApi.act(
          sessionId,
          scan.player.npl_id,
          option.action,
          {
            ...(option.tier !== undefined ? { tier: option.tier } : {}),
            ...(option.action === "jackpot" && jackpotWithBuyIn ? { first_buy_in: true } : {}),
          },
        )
        setSeating(result.seating)
        applied.push(option.label)
        total += priceFor(option)
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
      setCoveredOnline(null)
      setUseVoucher(false)
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
            placeholder="Scan a card, or type an NPL ID or a NAME, then Enter"
            aria-label="Scan or search a player"
            onChange={(e) => setValue(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                setNameHits([])
                void submitScan(value)
              }
              if (e.key === "Escape") {
                setNameHits([])
              }
            }}
          />
          {busy ? <Loader2 size={16} className="host-spin" /> : null}

          {nameHits.length > 0 && !busy ? (
            <div className="host-desk__namehits" role="listbox" aria-label="Matching players">
              {nameHits.map((hit) => (
                <button
                  key={hit.npl_id}
                  type="button"
                  className="host-desk__namehit"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setValue("")
                    setNameHits([])
                    void submitScan(hit.npl_id)
                  }}
                >
                  <strong>{hit.display_name}</strong>
                  <small>
                    {hit.npl_id}
                    {hit.public_player_code ? ` · ${hit.public_player_code}` : ""}
                    {hit.state_code ? ` · ${hit.state_code}` : ""}
                  </small>
                </button>
              ))}
            </div>
          ) : null}
        </label>

        <div className="host-desk__gates">
          {GATE_LABELS.filter(({ key }) => mode !== "cash" || key !== "addon").map(({ key, label }) => {
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

        {seating ? (
          <div className="host-desk__headcounts" aria-label="Tonight's counts">
            <span><small>In play</small><strong>{seating.counts.active}</strong></span>
            <span><small>Entries</small><strong>{seating.counts.entries}</strong></span>
            <span><small>Out</small><strong>{seating.counts.eliminated}</strong></span>
            <span><small>Jackpot</small><strong>{seating.counts.in_jackpot}</strong></span>
          </div>
        ) : null}

        {mode === "cash" && clockStatus === "draft" ? (
          <button
            className="host-desk__display"
            type="button"
            title="Start the cash game — the session goes live and preparation locks"
            disabled={busy}
            onClick={() => {
              void deskApi.startClock(sessionId).then(() => refresh()).catch((e) => {
                setError(e instanceof Error ? e.message : "The game could not be started.")
              })
            }}
          >
            <Play size={15} /> Start game
          </button>
        ) : null}
        {mode === "cash" && clockStatus !== "draft" ? (
          <CashTimer clock={seating?.clock as CashClockState | undefined} status={clockStatus} />
        ) : null}
        {mode !== "cash" ? <button
          className="host-desk__display"
          type="button"
          title="Open the room clock in its own window"
          onClick={() => {
            // A real window, not a tab: it gets dragged onto the projector and
            // left there. In the desktop shell the Go host builds the window
            // itself — a window.open popup would carry the browser process's
            // stock chrome, which no styling here can remove. The clock is
            // server-authoritative, so opening two can never make them disagree.
            const query = `?display=timer&session=${sessionId}`
            if (window.nplOpenRoomClock) {
              void window.nplOpenRoomClock(`${window.location.origin}${window.location.pathname}${query}`)
              return
            }
            window.open(
              `${window.location.pathname}${query}`,
              `npl-timer-${sessionId}`,
              "width=1280,height=720,menubar=no,toolbar=no,location=no,status=no",
            )
          }}
        >
          <MonitorPlay size={15} /> Room clock
        </button> : null}

        {onFinishGame ? (
          <button className="host-desk__finish" type="button" onClick={onFinishGame}>Finish game</button>
        ) : null}
        <button className="host-desk__exit" type="button" onClick={onExit}>Preset</button>
      </header>

      {error ? <p className="host-desk__error" role="alert">{error}</p> : null}
      {flash ? <p className="host-desk__flash" role="status">{flash}</p> : null}

      {voucherAsk ? (() => {
        const askBuyIn = voucherAsk.result.options.find((option) => option.action === "buy_in")
        const askDeficit = askBuyIn ? voucherDeficitCents(voucherAsk.voucher, askBuyIn.price_cents) : 0
        return (
          <div className="host-scan-modal" role="presentation">
            <section className="host-scan-modal__panel" role="alertdialog" aria-modal="true" aria-label="Entry voucher detected">
              <div className="host-voucher-ask">
                <span className="host-voucher-ask__icon"><Ticket size={24} /></span>
                <h3>{askDeficit > 0 ? "PART-COVERED ENTRY" : "FREE ENTRY"} — {voucherAsk.voucher.title || "entry voucher"}</h3>
                <p>
                  <strong>{voucherAsk.result.player.display_name}</strong> holds voucher{" "}
                  <code>{voucherAsk.voucher.code}</code>
                  {voucherAsk.voucher.unlimited_uses
                    ? " — pass active"
                    : voucherAsk.voucher.uses_remaining !== null
                      ? ` — ${voucherAsk.voucher.uses_remaining} use${voucherAsk.voucher.uses_remaining === 1 ? "" : "s"} left`
                      : ""}
                  {voucherAsk.voucher.expires_at ? `, valid until ${voucherAsk.voucher.expires_at}` : ""}.
                  {askDeficit > 0 && voucherAsk.voucher.entry_fee_limit_cents
                    ? ` It covers buy-ins up to $${(voucherAsk.voucher.entry_fee_limit_cents / 100).toLocaleString()} — this game leaves ${money(askDeficit)} to collect.`
                    : ""}
                  {" "}Use it for this buy-in?
                </p>
                <div className="host-voucher-ask__actions">
                  <button
                    type="button"
                    className="host-scan-modal__cancel"
                    onClick={() => {
                      setVoucher(null)
                      openActions(voucherAsk.result, false)
                      setVoucherAsk(null)
                    }}
                  >
                    No — normal fee
                  </button>
                  <button
                    type="button"
                    className="host-voucher-ask__yes"
                    autoFocus
                    onClick={() => {
                      setVoucher(voucherAsk.voucher)
                      openActions(voucherAsk.result, true)
                      setVoucherAsk(null)
                    }}
                  >
                    <Ticket size={15} /> {askDeficit > 0 ? `Use voucher — pay ${money(askDeficit)}` : "Use voucher — FREE entry"}
                  </button>
                </div>
              </div>
            </section>
          </div>
        )
      })() : null}

      {scan ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => { if (!busy) { setScan(null); setVoucher(null); setCoveredOnline(null); setUseVoucher(false); focusScan() } }}>
          <section
            className="host-scan-modal__panel"
            role="dialog"
            aria-modal="true"
            aria-label={`Actions for ${scan.player.display_name}`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {scanComments && scanComments.nplId === scan.player.npl_id ? (
              <div className="scan-comments" role="alertdialog" aria-modal="true" aria-label="Staff comments — review before continuing">
                <h5><MessageSquareWarning size={16} /> Staff comments on {scan.player.display_name}</h5>
                <small>First registration — review before continuing.</small>
                <ul className="scan-comments__list">
                  {scanComments.comments.map((comment) => (
                    <li key={comment.id}>
                      <div className="players-comments__meta">
                        <strong>{comment.author_name}</strong>
                        <span>
                          {comment.venue_name ? `${comment.venue_name} · ` : ""}
                          {new Date(comment.created_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}
                        </span>
                      </div>
                      <p>{comment.note}</p>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="scan-comments__ack"
                  autoFocus
                  onClick={() => {
                    seenCommentsRef.current.add(scanComments.seenKey)
                    setScanComments(null)
                  }}
                >
                  Acknowledge and continue
                </button>
              </div>
            ) : null}
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

            {coveredOnline && !scan.entry ? (() => {
              const buyInOption = scan.options.find((option) => option.action === "buy_in")
              const deficit = buyInOption ? coveredDeficitCents(coveredOnline, buyInOption.price_cents) : 0
              return (
                <p className="host-booking-banner host-booking-banner--voucher">
                  <Ticket size={14} />
                  {deficit > 0
                    ? ` Entry PAID ONLINE with voucher ${coveredOnline.code} — collect only the ${money(deficit)} difference. Do not charge the full buy-in.`
                    : ` Entry PAID ONLINE with voucher ${coveredOnline.code} — $0 due for the buy-in. Do not charge again.`}
                </p>
              )
            })() : null}

            {useVoucher && voucher && !scan.entry ? (() => {
              const buyInOption = scan.options.find((option) => option.action === "buy_in")
              const deficit = buyInOption ? voucherDeficitCents(voucher, buyInOption.price_cents) : 0
              return (
                <p className="host-booking-banner host-booking-banner--voucher">
                  <Ticket size={14} />
                  {deficit > 0
                    ? ` Voucher ${voucher.code} covers $${(((buyInOption?.price_cents ?? 0) - deficit) / 100).toLocaleString()} of the buy-in — collect the ${money(deficit)} difference.`
                    : ` Buy-in covered by voucher ${voucher.code} — $0 due for the entry.`}
                </p>
              )
            })() : null}

            <div className="host-scan-modal__options" role="group" aria-label="Tick the actions to take">
              {scan.options.filter((option) => mode !== "cash" || option.action !== "addon").map((option) => {
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
                    <span>
                      {priceFor(option) > 0 ? money(priceFor(option)) : (
                        <>
                          {useVoucher && option.action === "buy_in" && option.price_cents > 0
                            ? <s className="host-tick__was">{money(option.price_cents)}</s>
                            : null}
                          Free
                        </>
                      )}
                    </span>
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
                    .reduce((sum, option) => sum + priceFor(option), 0))}
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

      <div className="host-desk__body host-desk__body--full">
        <section className="host-desk__tables">
          {seating?.unseated.length ? (
            <div className="host-desk__pool">
              <h4>Waiting to be seated — drag onto a seat</h4>
              <div>
                {seating.unseated.map((player) => (
                  <button
                    key={player.npl_id}
                    type="button"
                    className="host-chip"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("text/npl-id", player.npl_id)
                      e.dataTransfer.effectAllowed = "move"
                      setDragging(player.npl_id)
                    }}
                    onDragEnd={() => setDragging(null)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, player })
                    }}
                  >
                    {player.club_member === false ? <span className="club-flag" title="No club membership ID" /> : null}
                    {player.display_name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="host-desk__grid">
            {seating?.tables.map((table) => (
              <article
                key={table.table_number}
                className="host-table"
                onContextMenu={(e) => {
                  // Right-click on the table itself (not a seat) offers
                  // deletion — but only when nobody is sitting there.
                  if (table.occupied > 0) return
                  e.preventDefault()
                  setTableMenu({ x: e.clientX, y: e.clientY, tableNumber: table.table_number })
                }}
              >
                <header>
                  <strong>Table {table.table_number}</strong>
                  <span>{table.occupied} / {seating.seats_per_table}</span>
                </header>
                <ul>
                  {table.seats.map((seat) => (
                    <li key={seat.seat_number}
                      className={[
                        "host-seat",
                        seat.player ? "host-seat--taken" : "",
                        !seat.player && dragging ? "host-seat--target" : "",
                      ].filter(Boolean).join(" ")}
                      draggable={seat.player !== null}
                      onDragStart={(e) => {
                        if (!seat.player) return
                        e.dataTransfer.setData("text/npl-id", seat.player.npl_id)
                        e.dataTransfer.effectAllowed = "move"
                        setDragging(seat.player.npl_id)
                      }}
                      onDragEnd={() => setDragging(null)}
                      onDragOver={(e) => {
                        if (seat.player) return
                        e.preventDefault()
                        e.dataTransfer.dropEffect = "move"
                      }}
                      onDrop={(e) => {
                        if (seat.player) return
                        e.preventDefault()
                        const nplId = e.dataTransfer.getData("text/npl-id")
                        setDragging(null)
                        if (!nplId) return
                        void seatAction(
                          () => deskApi.seat(sessionId, nplId, table.table_number, seat.seat_number),
                          `Moved to table ${table.table_number}, seat ${seat.seat_number}.`,
                        )
                      }}
                      onContextMenu={(e) => {
                        if (!seat.player) return
                        e.preventDefault()
                        e.stopPropagation()
                        setMenu({ x: e.clientX, y: e.clientY, player: seat.player })
                      }}
                    >
                      <span className="host-seat__no">{seat.seat_number}</span>
                      {seat.player ? (
                        <span className="host-seat__name">
                          {seat.player.club_member === false ? <span className="club-flag" title="No club membership ID" /> : null}
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

      {tableMenu ? (
        <div className="host-menu" style={{ left: tableMenu.x, top: tableMenu.y }} role="menu">
          <p>Table {tableMenu.tableNumber} — empty</p>
          <button
            type="button"
            onClick={() => {
              const gameSessionId = seating?.game_session_id ?? null
              setTableMenu(null)
              if (gameSessionId === null) {
                setError("This tournament is not linked to an online session — local tables grow and shrink automatically with the field.")
                return
              }
              void seatAction(
                async () => {
                  await deskApi.cancelCloudTable(gameSessionId, tableMenu.tableNumber)
                  notify("system", `Table ${tableMenu.tableNumber} deleted`, "Removed from the cloud seat map.", "warning")
                  return deskApi.seating(sessionId)
                },
                `Table ${tableMenu.tableNumber} deleted.`,
              )
            }}
          >
            <Ban size={14} /> Delete this table
          </button>
        </div>
      ) : null}

      {menu ? (
        <div className="host-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <p>{menu.player.display_name}</p>
          {(seating?.rebuy_tiers ?? []).length > 1 ? (
            // Two or more rebuy tiers: ask which one.
            (seating?.rebuy_tiers ?? []).map((tier, index) => (
              <button key={index} type="button" onClick={() => void seatAction(
                async () => {
                  await deskApi.act(sessionId, menu.player.npl_id, "rebuy", { tier: index })
                  return deskApi.seating(sessionId)
                },
                `Rebuy ${tier.chips.toLocaleString()} (${money(tier.price_cents)}) — ${menu.player.display_name}.`,
              )}>
                <RotateCcw size={14} /> Rebuy {tier.chips.toLocaleString()} · {money(tier.price_cents)}
              </button>
            ))
          ) : (
            <button type="button" onClick={() => void seatAction(
              async () => {
                await deskApi.act(sessionId, menu.player.npl_id, "rebuy")
                return deskApi.seating(sessionId)
              },
              `Rebuy taken for ${menu.player.display_name}.`,
            )}>
              <RotateCcw size={14} /> Rebuy
            </button>
          )}
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
          <button
            type="button"
            className="host-menu__danger"
            onClick={() => {
              const player = menu.player
              setMenu(null)
              setRemoveCandidate(player)
            }}
          >
            <X size={14} /> Remove player
          </button>
        </div>
      ) : null}

      {removeCandidate ? (
        <div className="host-scan-modal" role="presentation" onMouseDown={() => { if (!busy) setRemoveCandidate(null) }}>
          <section className="host-scan-modal__panel" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="host-finish__confirm-title">Remove {removeCandidate.display_name}?</h3>
            <p className="host-finish__confirm-copy">
              They leave this session completely — local entry gone, online registration cancelled,
              seat freed for the wait list. Money already taken stays on the ledger.
            </p>
            <footer className="host-scan-modal__footer">
              <span className="host-scan-modal__total" />
              <button type="button" className="host-scan-modal__cancel" disabled={busy} onClick={() => setRemoveCandidate(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="host-scan-modal__submit"
                disabled={busy}
                onClick={() => {
                  const player = removeCandidate
                  setRemoveCandidate(null)
                  void seatAction(
                    async () => {
                      const next = await deskApi.removePlayer(sessionId, player.npl_id)
                      notify("registration", `${player.display_name} removed`, "Kicked from the session — online registration cancelled.", "warning")
                      return next
                    },
                    `${player.display_name} removed from the session.`,
                  )
                }}
              >
                {busy ? "Removing…" : "Remove player"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  )
}
