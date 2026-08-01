<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Sync\ManualUpdateRunner;
use App\Services\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

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
        private readonly CloudClient $cloud,
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
     * Targeted refresh of the fast-moving entities only: game sessions and
     * their seat maps. Called when the realtime channel signals a change
     * (and by the UI's fallback poll) — small enough to run inline.
     */
    public function pullSessions(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $sessions = $this->sync->syncEntity('game_sessions');
            // Venue-scoped incremental refresh: a handful of calls, and it
            // covers the venue's WHOLE scheduled window — a desk may link
            // any of those sessions, not just tonight's.
            $seating = $this->sync->refreshSeatingFor(
                isset($validated['venue_id']) ? (int) $validated['venue_id'] : null,
            );
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => ['code' => $e->errorCode, 'message' => $e->getMessage()],
            ], 502);
        }

        return response()->json([
            'ok' => true,
            'data' => ['game_sessions' => $sessions, 'seating' => $seating],
        ]);
    }

    /**
     * Realtime connection details, proxied from the cloud so the UI can
     * open its WebSocket without the install shipping a baked-in key.
     */
    public function realtime(): JsonResponse
    {
        try {
            $details = $this->cloud->getJson('/api/v1/internal/realtime');
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => ['code' => $e->errorCode, 'message' => $e->getMessage()],
            ], 502);
        }

        return response()->json(['ok' => true, 'data' => $details['data'] ?? $details]);
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
            $result = $this->runner->startInBackground($validated['trigger_source'] ?? null);
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => ['code' => $e->errorCode, 'message' => $e->getMessage()],
            ], 422);
        }

        return response()->json(['ok' => true, 'data' => ['run' => $result]], 202);
    }

    /**
     * Re-install player avatars without a full pull.
     *
     * Separate from the full update because it is the one piece an operator
     * commonly wants on its own — a player changes their picture and the desk
     * wants it on the seating map now, not after a whole sync.
     */
    public function avatars(Request $request): JsonResponse
    {
        $force = (bool) $request->boolean('force');

        return response()->json([
            'ok' => true,
            'data' => ['avatars' => app(\App\Services\Media\AvatarInstaller::class)->installAll($force)],
        ]);
    }

    public function status(string $uuid): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['run' => $this->runner->status($uuid)]]);
    }

    public function latest(): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['run' => $this->runner->latest()]]);
    }

}
