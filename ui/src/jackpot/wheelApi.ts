import type { WheelHue, WheelPrize } from "./wheelPrizes"

/**
 * The wheel's slice of the local API. The composition comes from the local
 * mirror (filled by Manual update); the spin is proxied live to the NPL
 * cloud, which draws the winner and awards the prize.
 */

export type WheelSegment = {
  id: number
  segment_index: number
  label: string
  lines: [string, string]
  hue: string
  weight: number
  weight_percent: number
  benefit_type: "voucher" | "loyalty_points"
  voucher_type: string | null
  points_amount: number | null
}

export type WheelPlayer = {
  npl_id: string
  display_name: string
  avatar_media_key: string | null
  state_code: string | null
}

export type SpinResult = {
  spin_id: number
  reference: string
  duplicate: boolean
  segment_index: number
  wheel_prize_id: number
  prize: {
    label: string
    lines: [string, string]
    benefit_type: "voucher" | "loyalty_points"
    points_amount: number | null
  }
  player: { npl_id: string, display_name: string }
  voucher: { id: number, code: string, type: string, expires_at: string | null } | null
  points_amount: number | null
  spun_at: string
}

const HUES: WheelHue[] = ["electric", "gold", "cyan", "magenta", "violet", "green", "blue", "red"]

export function toWheelPrizes(segments: WheelSegment[]): WheelPrize[] {
  return segments.map((segment) => ({
    id: String(segment.id),
    prize: segment.label,
    lines: segment.lines,
    weight: segment.weight_percent,
    hue: HUES.includes(segment.hue as WheelHue) ? (segment.hue as WheelHue) : "electric",
  }))
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string }, errors?: Record<string, string[]> }
    | null

  if (!response.ok || body?.ok === false) {
    const validation = body?.errors ? Object.values(body.errors).flat()[0] : null
    throw new Error(body?.error?.message || validation || body?.message || "The local wheel service failed.")
  }

  return (body?.data ?? body) as T
}

export const wheelApi = {
  segments: () => request<{ segments: WheelSegment[] }>("/api/v1/wheel"),

  lookup: (nplId: string) =>
    request<{ player: WheelPlayer }>("/api/v1/wheel/lookup", {
      method: "POST",
      body: JSON.stringify({ npl_id: nplId }),
    }),

  spin: (reference: string, nplId: string, venueId: number | null) =>
    request<{ spin: SpinResult }>("/api/v1/wheel/spin", {
      method: "POST",
      body: JSON.stringify({ reference, npl_id: nplId, venue_id: venueId }),
    }),
} as const
