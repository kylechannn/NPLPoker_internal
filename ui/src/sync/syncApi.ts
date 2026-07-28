/**
 * Manual update: pulling the cloud's data down to this laptop.
 *
 * The POST hands back a queued run and the pull happens in a detached php
 * process — the bundled dev server is single-threaded on Windows, so an
 * inline pull would freeze every desk endpoint for its whole duration. The
 * UI polls the run until it finishes; the result carries per-entity counts,
 * which is what the operator actually wants to see: "did the venues and
 * tonight's sessions actually arrive?"
 */

type EntityResult = {
  status?: string
  /** Full-pull entities report `rows`; delta entities report `upserted`. */
  rows?: number
  upserted?: number
  deleted?: number
  not_modified?: boolean
  message?: string | null
}

export type SyncRun = {
  uuid: string
  status: string
  stage: string | null
  progress: number
  rows_written?: number
  started_at: string | null
  finished_at: string | null
  error: string | null
  summary: {
    entities?: Record<string, EntityResult>
    media?: Record<string, unknown>
    warnings?: string[]
  } | null
}

export type SyncEntityState = {
  entity: string
  label: string
  table: string | null
  status: string
  row_count: number
  last_success_at: string | null
  last_error: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })

  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean, data?: T, message?: string, error?: { message?: string }, errors?: Record<string, string[]> }
    | null

  if (!response.ok || body?.ok === false) {
    const fieldError = body?.errors ? Object.values(body.errors)[0]?.[0] : undefined
    throw new Error(fieldError ?? body?.error?.message ?? body?.message ?? `Update failed (${response.status})`)
  }

  return body?.data as T
}

export const syncApi = {
  run: (triggerSource = 'console') =>
    request<{ run: SyncRun }>('/api/v1/sync/run', {
      method: 'POST',
      body: JSON.stringify({ trigger_source: triggerSource }),
    }),

  latest: () => request<{ run: SyncRun | null }>('/api/v1/sync/runs/latest'),

  status: (uuid: string) => request<{ run: SyncRun }>(`/api/v1/sync/runs/${uuid}`),

  /** Resolves when the run leaves queued/running, reporting progress along the way. */
  awaitRun: async (run: SyncRun, onProgress?: (run: SyncRun) => void): Promise<SyncRun> => {
    let current = run
    while (current.status === 'queued' || current.status === 'running') {
      onProgress?.(current)
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      current = (await syncApi.status(current.uuid)).run
    }
    return current
  },

  manifest: () =>
    request<{ cloud_base: string, entities: SyncEntityState[] }>('/api/v1/sync/manifest'),

  avatars: (force = false) =>
    request<{ avatars: Record<string, number> }>(`/api/v1/sync/avatars${force ? '?force=1' : ''}`, {
      method: 'POST',
    }),
}

/** A one-line summary of what a run actually brought down. */
export function describeRun(run: SyncRun | null): string {
  if (!run) return 'No update has run yet.'

  if (run.status !== 'succeeded') {
    return run.error ?? `Update ${run.status}.`
  }

  const parts = Object.entries(run.summary?.entities ?? {})
    .map(([entity, result]) => {
      // Two shapes: a full pull counts `rows`, a delta counts `upserted`.
      const written = Number(result?.rows ?? result?.upserted ?? 0)
      const deleted = Number(result?.deleted ?? 0)
      if (written === 0 && deleted === 0) return null
      return `${entity.replace(/_/g, ' ')} ${written}${deleted ? ` (−${deleted})` : ''}`
    })
    .filter(Boolean)

  if (parts.length === 0) return 'Already up to date — nothing changed.'

  return `Updated: ${parts.join(', ')}.`
}
