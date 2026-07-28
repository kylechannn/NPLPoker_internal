import { ArrowDown, ArrowUp, Coffee, Copy, Plus, Trash2 } from "lucide-react"
import type { GeneratedLevel } from "./deskApi"

export type CutOffKind = "registration" | "rebuy" | "addon" | "jackpot"

export const CUT_OFF_META: Record<CutOffKind, { label: string, short: string }> = {
  registration: { label: "Registration", short: "REG" },
  rebuy: { label: "Rebuys", short: "RE" },
  addon: { label: "Add-ons", short: "ADD" },
  jackpot: { label: "Jackpot", short: "JP" },
}

type Props = {
  levels: GeneratedLevel[]
  cutOffs: Partial<Record<CutOffKind, number>>
  onChange: (levels: GeneratedLevel[]) => void
}

/**
 * The blind ladder, editable row by row.
 *
 * The pattern generator is only ever a starting point — real structures
 * almost always have a hand-tuned level or two near the bubble, a longer
 * dinner break, or a deliberate jump. So every value here is directly
 * editable and rows can be added, duplicated, moved or removed; nothing
 * forces a level to stay on the generated curve.
 *
 * Level numbers are derived, never typed: blinds count up, and a break
 * carries the number of the level before it, so "registration closes at
 * level 6" keeps meaning the same thing however the ladder is rearranged.
 */
export default function LadderEditor({ levels, cutOffs, onChange }: Props) {
  function renumber(rows: GeneratedLevel[]): GeneratedLevel[] {
    let levelNo = 0

    return rows.map((row, index) => {
      if (row.type === "blind") levelNo += 1

      return { ...row, level_no: levelNo || 1, sort_order: index + 1 }
    })
  }

  function patch(index: number, changes: Partial<GeneratedLevel>) {
    onChange(renumber(levels.map((row, i) => (i === index ? { ...row, ...changes } : row))))
  }

  function insertAfter(index: number, type: "blind" | "break") {
    const previous = levels[index]
    const blank: GeneratedLevel = type === "break"
      ? {
          level_no: 0, type: "break", small_blind: 0, big_blind: 0, ante: 0, bb_ante: 0,
          duration_min: 15, sort_order: 0, note: "Break",
        }
      : {
          level_no: 0,
          type: "blind",
          // A new level opens where the previous one left off, doubled —
          // a sensible guess that is immediately editable.
          small_blind: previous ? Math.max(1, previous.small_blind * 2) : 100,
          big_blind: previous ? Math.max(2, previous.big_blind * 2) : 200,
          ante: 0,
          bb_ante: previous?.bb_ante ? previous.bb_ante * 2 : 0,
          duration_min: previous?.duration_min ?? 20,
          sort_order: 0,
          note: null,
        }

    const next = [...levels]
    next.splice(index + 1, 0, blank)
    onChange(renumber(next))
  }

  function duplicate(index: number) {
    const next = [...levels]
    next.splice(index + 1, 0, { ...levels[index] })
    onChange(renumber(next))
  }

  function remove(index: number) {
    onChange(renumber(levels.filter((_, i) => i !== index)))
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= levels.length) return

    const next = [...levels]
    const [row] = next.splice(index, 1)
    next.splice(target, 0, row)
    onChange(renumber(next))
  }

  const totalMinutes = levels.reduce((sum, row) => sum + row.duration_min, 0)

  // Where each cut-off lands, so the operator can see the line in the ladder
  // it actually refers to rather than holding a row number in their head.
  const marks = new Map<number, CutOffKind[]>()
  for (const [kind, position] of Object.entries(cutOffs)) {
    if (!position) continue
    const list = marks.get(position) ?? []
    list.push(kind as CutOffKind)
    marks.set(position, list)
  }

  return (
    <div className="ladder">
      <div className="ladder__head">
        <span className="ladder__col ladder__col--no">#</span>
        <span className="ladder__col">Small</span>
        <span className="ladder__col">Big</span>
        <span className="ladder__col">BB ante</span>
        <span className="ladder__col">Min</span>
        <span className="ladder__col ladder__col--tools" />
      </div>

      <div className="ladder__rows">
        {levels.map((row, index) => {
          const flags = marks.get(index + 1) ?? []

          return (
            <div
              key={`${index}-${row.sort_order}`}
              className={[
                "ladder__row",
                row.type === "break" ? "ladder__row--break" : "",
                flags.length ? "ladder__row--marked" : "",
              ].filter(Boolean).join(" ")}
            >
              <div className="ladder__no">
                <span>{index + 1}</span>
                {row.type === "blind" ? <em>L{row.level_no}</em> : <em>br</em>}
              </div>

              {row.type === "break" ? (
                <input
                  className="ladder__note"
                  value={row.note ?? ""}
                  placeholder="Break"
                  aria-label={`Break label for row ${index + 1}`}
                  onChange={(e) => patch(index, { note: e.target.value })}
                />
              ) : (
                <>
                  <input
                    type="number" min={0} value={row.small_blind}
                    aria-label={`Small blind, level ${row.level_no}`}
                    onChange={(e) => patch(index, { small_blind: Number(e.target.value) })}
                  />
                  <input
                    type="number" min={0} value={row.big_blind}
                    aria-label={`Big blind, level ${row.level_no}`}
                    onChange={(e) => patch(index, { big_blind: Number(e.target.value) })}
                  />
                  <input
                    type="number" min={0} value={row.bb_ante}
                    aria-label={`Big blind ante, level ${row.level_no}`}
                    onChange={(e) => patch(index, { bb_ante: Number(e.target.value) })}
                  />
                </>
              )}

              <input
                type="number" min={1} max={600} value={row.duration_min}
                aria-label={`Minutes, row ${index + 1}`}
                onChange={(e) => patch(index, { duration_min: Number(e.target.value) })}
              />

              <div className="ladder__tools">
                {flags.map((flag) => (
                  <span key={flag} className={`ladder__flag ladder__flag--${flag}`} title={`${CUT_OFF_META[flag].label} closes here`}>
                    {CUT_OFF_META[flag].short}
                  </span>
                ))}
                <button type="button" title="Move up" aria-label={`Move row ${index + 1} up`} onClick={() => move(index, -1)}>
                  <ArrowUp size={13} />
                </button>
                <button type="button" title="Move down" aria-label={`Move row ${index + 1} down`} onClick={() => move(index, 1)}>
                  <ArrowDown size={13} />
                </button>
                <button type="button" title="Duplicate" aria-label={`Duplicate row ${index + 1}`} onClick={() => duplicate(index)}>
                  <Copy size={13} />
                </button>
                <button type="button" title="Add level below" aria-label={`Add a level after row ${index + 1}`} onClick={() => insertAfter(index, "blind")}>
                  <Plus size={13} />
                </button>
                <button type="button" title="Add break below" aria-label={`Add a break after row ${index + 1}`} onClick={() => insertAfter(index, "break")}>
                  <Coffee size={13} />
                </button>
                <button type="button" className="ladder__danger" title="Remove" aria-label={`Remove row ${index + 1}`} onClick={() => remove(index)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="ladder__foot">
        <button type="button" onClick={() => insertAfter(levels.length - 1, "blind")}>
          <Plus size={14} /> Level
        </button>
        <button type="button" onClick={() => insertAfter(levels.length - 1, "break")}>
          <Coffee size={14} /> Break
        </button>
        <span>
          {levels.filter((row) => row.type === "blind").length} levels &middot;{" "}
          {Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m
        </span>
      </div>
    </div>
  )
}
