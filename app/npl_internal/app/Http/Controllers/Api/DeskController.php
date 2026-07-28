<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Tournament\BlindStructureGenerator;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentGateService;
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
        private readonly TournamentGateService $gates,
        private readonly BlindStructureGenerator $structures,
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
     * Everything the dashboard shows for one venue. Scoping here rather than
     * filtering in the browser means a laptop at one club never holds
     * another club's roster in memory.
     */
    public function dashboard(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        $venueId = $validated['venue_id'] ?? null;

        $sessions = DB::table('tournament_sessions')
            ->when($venueId !== null, fn ($query) => $query->where('venue_id', $venueId))
            ->orderByDesc('id')
            ->limit(25)
            ->get()
            ->map(fn (object $row): array => [
                'id' => (int) $row->id,
                'uuid' => $row->uuid,
                'name' => $row->name,
                'status' => $row->status,
                'venue_id' => $row->venue_id !== null ? (int) $row->venue_id : null,
                'venue_name' => $row->venue_name,
                'started_at' => $row->started_at,
                'entries' => (int) DB::table('tournament_entries')
                    ->where('tournament_session_id', $row->id)
                    ->count(),
                'active' => (int) DB::table('tournament_entries')
                    ->where('tournament_session_id', $row->id)
                    ->where('status', 'active')
                    ->count(),
            ])
            ->all();

        $upcoming = DB::table('mirror_game_sessions')
            ->when($venueId !== null, fn ($query) => $query->where('venue_id', $venueId))
            ->orderBy('session_date')
            ->limit(10)
            ->get()
            ->all();

        return $this->ok([
            'venue_id' => $venueId,
            'sessions' => $sessions,
            'upcoming' => $upcoming,
            'players_mirrored' => (int) DB::table('mirror_players')->count(),
        ]);
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
            'table_number' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'seat_number' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'idempotency_key' => ['sometimes', 'nullable', 'string', 'max:64'],
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

    /** Gate state on its own — what a display polls to show the countdown. */
    public function gates(int $id): JsonResponse
    {
        return $this->ok(['gates' => $this->gates->gates($id)]);
    }

    private function ok(array $data, int $status = 200): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data], $status);
    }
}
