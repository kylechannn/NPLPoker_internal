<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Tournament\BlindStructureGenerator;
use App\Services\Tournament\TournamentDeskService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * The operator's desk: scanning players in, taking money, and moving people
 * around the tables.
 *
 * Split from TournamentController because the desk is a different job from
 * running the clock — one is the tournament director's screen, the other is
 * whoever is standing at the door with a scanner.
 */
final class DeskController
{
    public function __construct(
        private readonly TournamentDeskService $desk,
        private readonly BlindStructureGenerator $structures,
        private readonly \App\Services\Cloud\CloudClient $cloud,
        private readonly \App\Services\Sync\SyncService $sync,
    ) {}

    /** Venues this install can host for — drives the header picker. */
    public function venues(): JsonResponse
    {
        $venues = DB::table('mirror_venues')
            ->orderBy('venue_name')
            ->get(['cloud_id', 'venue_name', 'state_code', 'suburb', 'media_key'])
            ->map(fn (object $row): array => [
                'id' => (int) $row->cloud_id,
                'name' => $row->venue_name,
                'state_code' => $row->state_code,
                'suburb' => $row->suburb,
                'media_key' => $row->media_key,
            ])
            ->all();

        return $this->ok(['venues' => $venues]);
    }

    /**
     * Upcoming cloud-scheduled sessions for the picked venue — the express
     * way into a night: the overview lists them and one tap opens the right
     * workspace (cash game or tournament).
     */
    /**
     * Every session in the sync window, any status — the Registrations tab
     * groups these by date so staff can read the whole online record.
     */
    public function allSessions(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        $venueId = $validated['venue_id'] ?? null;

        $sessions = DB::table('mirror_game_sessions')
            ->when($venueId !== null, fn ($query) => $query->where('venue_id', $venueId))
            ->orderBy('session_date')
            ->orderBy('start_time')
            ->get()
            ->map(fn (object $row): array => [
                'session_id' => (int) $row->session_id,
                'title' => $row->title,
                'category' => $row->category,
                'venue_id' => $row->venue_id !== null ? (int) $row->venue_id : null,
                'venue_name' => $row->venue_name,
                'session_date' => $row->session_date,
                'start_time' => $row->start_time,
                'status' => $row->status,
                'registrations_count' => (int) $row->registrations_count,
                'max_players' => $row->max_players !== null ? (int) $row->max_players : null,
            ])
            ->values()
            ->all();

        return $this->ok(['sessions' => $sessions]);
    }

    /** The live online registration record — names, NPL IDs and times. */
    public function onlineRegistrations(int $gameSessionId): JsonResponse
    {
        try {
            $result = $this->cloud->getJson(sprintf('/api/v1/internal/sessions/%d/registrations', $gameSessionId));
        } catch (\App\Services\Cloud\CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === \App\Services\Cloud\CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — the registration record needs a connection.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        return $this->ok(['result' => $result['data'] ?? $result]);
    }

    public function upcomingSessions(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        $venueId = $validated['venue_id'] ?? null;

        $sessions = DB::table('mirror_game_sessions')
            ->when($venueId !== null, fn ($query) => $query->where('venue_id', $venueId))
            ->where('status', 'scheduled')
            ->whereDate('session_date', '>=', now()->toDateString())
            ->orderBy('session_date')
            ->orderBy('start_time')
            ->limit(20)
            ->get()
            ->map(function (object $row): array {
                // Live table count from the mirror, kept fresh by the
                // realtime pull — the sessions hub leans on this number.
                $tablesCount = (int) DB::table('mirror_session_tables')
                    ->where('session_id', $row->session_id)
                    ->where(fn ($query) => $query->whereNull('table_status')->orWhere('table_status', '!=', 'cancelled'))
                    ->distinct()
                    ->count('table_number');

                // An already-opened local tournament for this session means
                // "resume the desk", not "prepare again".
                $local = DB::table('tournament_sessions')
                    ->where('game_session_id', $row->session_id)
                    ->orderByDesc('id')
                    ->first(['id', 'status']);

                return [
                    'session_id' => (int) $row->session_id,
                    'title' => $row->title,
                    'category' => $row->category,
                    'source_type' => $row->source_type,
                    'venue_id' => $row->venue_id !== null ? (int) $row->venue_id : null,
                    'venue_name' => $row->venue_name,
                    'session_date' => $row->session_date,
                    'start_time' => $row->start_time,
                    'registrations_count' => (int) $row->registrations_count,
                    'max_players' => $row->max_players !== null ? (int) $row->max_players : null,
                    'tables_count' => $tablesCount,
                    'local_tournament_id' => $local !== null ? (int) $local->id : null,
                    'local_tournament_status' => $local?->status,
                ];
            })
            ->all();

        return $this->ok(['venue_id' => $venueId, 'sessions' => $sessions]);
    }

    /**
     * The online roster for one cloud session, straight from the live
     * mirror: seated players, wait-lists, and the table shapes.
     */
    public function sessionRoster(int $gameSessionId): JsonResponse
    {
        $rows = DB::table('mirror_session_tables')
            ->where('session_id', $gameSessionId)
            ->orderBy('table_number')
            ->orderBy('seat_number')
            ->get();

        $tables = $rows
            ->groupBy('table_number')
            ->map(fn ($seats, $tableNumber): array => [
                'table_number' => (int) $tableNumber,
                'status' => optional($seats->first())->table_status,
                'max_seats' => (int) (optional($seats->first())->max_seats ?? 8),
                'players' => $seats
                    ->filter(fn (object $seat): bool => $seat->player_npl_id !== null)
                    ->map(fn (object $seat): array => [
                        'npl_id' => (string) $seat->player_npl_id,
                        'display_name' => $seat->player_display_name,
                        'seat_number' => $seat->seat_number !== null ? (int) $seat->seat_number : null,
                        'status' => $seat->registration_status,
                        'waitlist_position' => $seat->waitlist_position !== null ? (int) $seat->waitlist_position : null,
                    ])
                    ->values()
                    ->all(),
            ])
            ->values()
            ->all();

        return $this->ok(['session_id' => $gameSessionId, 'tables' => $tables]);
    }

    /** Cancel a cloud table — synchronous, then refresh the mirror. */
    public function cancelCloudTable(int $gameSessionId, int $tableNumber): JsonResponse
    {
        return $this->cloudDeskCall(sprintf(
            '/api/v1/internal/sessions/%d/tables/%d',
            $gameSessionId,
            $tableNumber,
        ), $gameSessionId);
    }

    /** Remove a player's online registration — synchronous, then refresh. */
    public function removeCloudRegistration(int $gameSessionId, string $nplId): JsonResponse
    {
        return $this->cloudDeskCall(sprintf(
            '/api/v1/internal/sessions/%d/registrations/%s',
            $gameSessionId,
            rawurlencode($nplId),
        ), $gameSessionId);
    }

    /** Staff move a wait-listed player into the first free seat, cloud-side. */
    public function promoteCloudRegistration(int $gameSessionId, string $nplId): JsonResponse
    {
        try {
            $result = $this->cloud->postJson(sprintf(
                '/api/v1/internal/sessions/%d/registrations/%s/promote',
                $gameSessionId,
                rawurlencode($nplId),
            ), []);
        } catch (\App\Services\Cloud\CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === \App\Services\Cloud\CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — promoting needs a connection. Try again when the link is green.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        return $this->ok(['result' => $result['data'] ?? $result]);
    }

    private function cloudDeskCall(string $path, ?int $gameSessionId = null): JsonResponse
    {
        try {
            $result = $this->cloud->deleteJson($path);
        } catch (\App\Services\Cloud\CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === \App\Services\Cloud\CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — this change needs a connection. Try again when the link is green.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        try {
            $this->sync->syncEntity('game_sessions');
            $this->sync->refreshSeatingFor(null, $gameSessionId !== null ? [$gameSessionId] : null);
        } catch (\Throwable) {
            // The realtime signal will bring the mirror up to date anyway.
        }

        return $this->ok(['result' => $result['data'] ?? $result]);
    }

    /**
     * Open a new table for a cloud-linked tournament. Synchronous to the
     * cloud on purpose — the operator is watching the seating map and the
     * cloud's table list is the layout authority for linked sessions.
     */
    public function createTable(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'max_seats' => ['sometimes', 'integer', 'min:2', 'max:10'],
        ]);

        $session = DB::table('tournament_sessions')->where('id', $id)->first();
        abort_if($session === null, 404);

        if ($session->game_session_id === null) {
            // Unlinked ad-hoc tournament: tables are pure head-count math,
            // there is nothing to create anywhere.
            throw \Illuminate\Validation\ValidationException::withMessages([
                'table' => ['This tournament is not linked to an online session — tables grow automatically with the field.'],
            ]);
        }

        try {
            $result = $this->cloud->postJson(
                sprintf('/api/v1/internal/sessions/%d/tables', (int) $session->game_session_id),
                ['max_seats' => (int) ($validated['max_seats'] ?? ($session->seats_per_table ?: 8))],
            );
        } catch (\App\Services\Cloud\CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === \App\Services\Cloud\CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — a new table needs a connection. Try again when the link is green.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        // Refresh just this session's mirror rows so the new table is on
        // the seating map before the operator's eyes leave the button.
        try {
            $this->sync->refreshSeatingFor(null, [(int) $session->game_session_id]);
        } catch (\Throwable) {
            // The realtime signal from the cloud will bring it in anyway.
        }

        return $this->ok([
            'table' => $result['data'] ?? $result,
            'seating' => $this->desk->seating($id),
        ]);
    }

    /** Kick a player out of the tournament (and their cloud registration). */
    public function removePlayer(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
        ]);

        return $this->ok(['seating' => $this->desk->removePlayer($id, $validated['player_npl_id'])]);
    }

    /**
     * Finish the game with the night's top placements. The desk waits on
     * this: it finishes the clock, records positions, and pushes the
     * standings to the cloud before answering.
     */
    public function finalise(Request $request, int $id): JsonResponse
    {
        // Cash games finish with NO placements — nothing is ranked, the
        // session just completes. Tournaments still scan their top 10.
        $validated = $request->validate([
            'placements' => ['present', 'array', 'max:10'],
            'placements.*.npl_id' => ['required', 'string', 'max:32'],
            'placements.*.position' => ['required', 'integer', 'min:1', 'max:10', 'distinct'],
        ]);

        $result = $this->desk->finishWithResults($id, $validated['placements']);

        return $this->ok(['result' => $result]);
    }

    /** Preview a blind ladder before committing to it. */
    public function previewStructure(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'levels' => ['sometimes', 'integer', 'min:1', 'max:60'],
            'duration_min' => ['sometimes', 'integer', 'min:1', 'max:180'],
            'small_blind' => ['sometimes', 'integer', 'min:1'],
            'big_blind_multiple' => ['sometimes', 'numeric', 'min:1'],
            'mode' => ['sometimes', Rule::in(['add', 'multiply'])],
            'step' => ['sometimes', 'numeric', 'min:0.1'],
            'break_every' => ['sometimes', 'integer', 'min:0', 'max:20'],
            'break_duration_min' => ['sometimes', 'integer', 'min:1', 'max:120'],
            'ante_from_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'ante_as_big_blind' => ['sometimes', 'boolean'],
        ]);

        $levels = $this->structures->generate($validated);

        return $this->ok([
            'levels' => $levels,
            'preview' => $this->structures->describe($levels),
            'total_minutes' => array_sum(array_column($levels, 'duration_min')),
        ]);
    }

    /** Look a player up. Charges nothing — see TournamentDeskService::scan. */
    public function scan(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
        ]);

        return $this->ok($this->desk->scan($id, $validated['player_npl_id']));
    }

    public function act(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
            'action' => ['required', Rule::in(['buy_in', 'rebuy', 'addon', 'jackpot'])],
            'tier' => ['sometimes', 'integer', 'min:0', 'max:9'],
            'table_number' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'seat_number' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'idempotency_key' => ['sometimes', 'nullable', 'string', 'max:64'],
            // Set only after the cloud confirmed the voucher redemption —
            // it books the buy-in with the code on the action, charging only
            // what the voucher's entry-fee limit leaves uncovered.
            'voucher_code' => ['sometimes', 'nullable', 'string', 'max:20'],
            'voucher_limit_cents' => ['sometimes', 'nullable', 'integer', 'min:0'],
            // Cash desks: the jackpot tick rode the same submit as the
            // buy-in — the only moment a cash player may join it.
            'first_buy_in' => ['sometimes', 'boolean'],
        ]);

        $result = $this->desk->apply($id, $validated['player_npl_id'], $validated['action'], $validated);

        return $this->ok([
            'result' => $result,
            'seating' => $this->desk->seating($id),
        ]);
    }

    public function seating(int $id): JsonResponse
    {
        return $this->ok($this->desk->seating($id));
    }

    /**
     * Pull phone requests the admin resolved at the table and apply them
     * to the local ledger. Called on a timer while the desk is open.
     */
    public function serviceSync(int $id, \App\Services\Tournament\TableServicePuller $puller): JsonResponse
    {
        return $this->ok($puller->sync($id));
    }

    /**
     * The desk handles a phone request itself — money kinds go into the
     * ledger here first, then the cloud learns "resolved, already applied".
     */
    public function serviceHandle(Request $request, int $id, \App\Services\Tournament\TableServicePuller $puller): JsonResponse
    {
        $validated = $request->validate([
            'request_id' => ['required', 'integer', 'min:1'],
        ]);

        $handled = $puller->handle($id, (int) $validated['request_id']);

        return $this->ok([
            'handled' => $handled,
            'seating' => $this->desk->seating($id),
        ]);
    }

    public function eliminate(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
            'knocked_out_by' => ['sometimes', 'nullable', 'string', 'max:32'],
            'idempotency_key' => ['sometimes', 'nullable', 'string', 'max:64'],
        ]);

        return $this->ok($this->desk->eliminate($id, $validated['player_npl_id'], $validated));
    }

    public function reinstate(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
        ]);

        return $this->ok($this->desk->reinstate($id, $validated['player_npl_id']));
    }

    public function seat(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
            'table_number' => ['present', 'nullable', 'integer', 'min:1'],
            'seat_number' => ['present', 'nullable', 'integer', 'min:1'],
        ]);

        return $this->ok($this->desk->seat(
            $id,
            $validated['player_npl_id'],
            $validated['table_number'],
            $validated['seat_number'],
        ));
    }

    private function ok(array $data, int $status = 200): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data], $status);
    }
}
