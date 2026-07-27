<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Cloud\CloudException;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Sync\ManualUpdateRunner;
use App\Services\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Local sync surface consumed by the Go host and both UIs.
 * Loopback-only in practice: the Go host owns the listener.
 */
final class SyncController
{
    public function __construct(
        private readonly ManualUpdateRunner $runner,
        private readonly SyncService $sync,
        private readonly LicenseKeyProvider $license,
    ) {}

    /**
     * The shared entity manifest. The UIs and the Go host read this instead
     * of each hardcoding their own list, which is how EdgeHost ended up with
     * three lists that disagreed about what "update everything" meant.
     */
    public function manifest(): JsonResponse
    {
        $entities = [];

        foreach ($this->runner->orderedEntities() as $entity) {
            $definition = config("nplcloud.entities.{$entity}", []);
            $state = $this->sync->state($entity);

            $entities[] = [
                'entity' => $entity,
                'label' => $definition['label'] ?? $entity,
                'table' => $definition['table'] ?? null,
                'status' => $state->status,
                'row_count' => (int) $state->row_count,
                'last_success_at' => $state->last_success_at,
                'last_error' => $state->last_error,
            ];
        }

        return response()->json([
            'ok' => true,
            'data' => [
                'cloud_base' => config('nplcloud.base'),
                'activated' => $this->license->isActivated(),
                'lease_valid' => $this->license->leaseValid(),
                'entities' => $entities,
            ],
        ]);
    }

    /**
     * Start a manual update. Returns 202 with the run id — the caller polls
     * `status` rather than holding an unbounded request open.
     */
    public function run(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'trigger_source' => ['sometimes', 'nullable', 'string', 'max:120'],
            'force' => ['sometimes', 'boolean'],
        ]);

        try {
            $result = $this->runner->start($validated['trigger_source'] ?? null);
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => ['code' => $e->errorCode, 'message' => $e->getMessage()],
            ], 422);
        }

        return response()->json(['ok' => true, 'data' => ['run' => $result]], 202);
    }

    public function status(string $uuid): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['run' => $this->runner->status($uuid)]]);
    }

    public function latest(): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['run' => $this->runner->latest()]]);
    }

    /** What the operational UI reads: the mirrored snapshot itself. */
    public function snapshot(Request $request): JsonResponse
    {
        $date = $request->string('date')->toString();

        $sessions = DB::table('mirror_game_sessions')
            ->when($date !== '', fn ($query) => $query->where('session_date', $date))
            ->orderBy('session_date')
            ->orderBy('start_time')
            ->get();

        $seating = DB::table('mirror_session_tables')
            ->whereIn('session_id', $sessions->pluck('session_id'))
            ->orderBy('table_number')
            ->orderBy('seat_number')
            ->get()
            ->groupBy('session_id');

        return response()->json([
            'ok' => true,
            'data' => [
                'venues' => DB::table('mirror_venues')->orderBy('venue_name')->get(),
                'sessions' => $sessions->map(fn (object $session): array => [
                    'session_id' => (int) $session->session_id,
                    'title' => $session->title,
                    'category' => $session->category,
                    'venue_name' => $session->venue_name,
                    'session_date' => $session->session_date,
                    'start_time' => $session->start_time,
                    'status' => $session->status,
                    'registrations_count' => (int) $session->registrations_count,
                    'max_players' => $session->max_players,
                    'image' => $session->media_key ? '/media/'.$session->media_key : null,
                    'seating' => $seating->get($session->session_id, collect())->values(),
                ])->values(),
            ],
        ]);
    }
}
