<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * Operator-facing tournament API. The clock endpoints are deliberately cheap
 * to call: every display polls `clock` to re-sync and ticks locally between
 * calls, so a big screen and a phone never disagree.
 */
final class TournamentController
{
    public function __construct(
        private readonly TournamentService $tournaments,
        private readonly TournamentClockService $clock,
    ) {}

    public function index(): JsonResponse
    {
        return $this->ok(['sessions' => $this->tournaments->listSessions()]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:160'],
            'venue_name' => ['sometimes', 'nullable', 'string', 'max:160'],
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
            'game_entity_id' => ['sometimes', 'nullable', 'integer'],
            'starting_stack' => ['sometimes', 'integer', 'min:1'],
            'rebuy_chips' => ['sometimes', 'integer', 'min:0'],
            'rebuy_price_cents' => ['sometimes', 'integer', 'min:0'],
            'max_rebuys_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'addon_chips' => ['sometimes', 'integer', 'min:0'],
            'addon_price_cents' => ['sometimes', 'integer', 'min:0'],
            'max_addons_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'buy_in_price_cents' => ['sometimes', 'integer', 'min:0'],
            'ko_bounty_cents' => ['sometimes', 'integer', 'min:0'],
            'registration_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:0'],
            'levels' => ['sometimes', 'array', 'min:1'],
            'levels.*.type' => ['sometimes', Rule::in(['blind', 'break'])],
            'levels.*.small_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.big_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.duration_min' => ['sometimes', 'integer', 'min:1', 'max:600'],
        ]);

        return $this->ok($this->tournaments->create($validated), 201);
    }

    public function show(int $id): JsonResponse
    {
        return $this->ok($this->tournaments->show($id));
    }

    public function updateStructure(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'levels' => ['required', 'array', 'min:1'],
            'levels.*.type' => ['sometimes', Rule::in(['blind', 'break'])],
            'levels.*.small_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.big_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.duration_min' => ['sometimes', 'integer', 'min:1', 'max:600'],
        ]);

        return $this->ok($this->tournaments->updateStructure($id, $validated['levels']));
    }

    /** The one endpoint every display polls. */
    public function clock(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->state($id)]);
    }

    public function start(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->start($id)]);
    }

    public function pause(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->pause($id)]);
    }

    public function resume(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->resume($id)]);
    }

    public function nextLevel(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->nextLevel($id)]);
    }

    public function previousLevel(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->previousLevel($id)]);
    }

    public function adjustTime(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'seconds' => ['required', 'integer', 'min:-3600', 'max:3600'],
        ]);

        return $this->ok(['clock' => $this->clock->adjustTime($id, (int) $validated['seconds'])]);
    }

    public function finish(int $id): JsonResponse
    {
        return $this->ok(['clock' => $this->clock->finish($id)]);
    }

    public function players(int $id): JsonResponse
    {
        return $this->ok([
            'players' => $this->tournaments->players($id),
            'summary' => $this->tournaments->summary($id),
        ]);
    }

    public function register(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
            'player_name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'table_number' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'seat_number' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:10'],
        ]);

        return $this->ok($this->tournaments->register(
            $id,
            $validated['player_npl_id'],
            $validated['player_name'] ?? null,
            $validated['table_number'] ?? null,
            $validated['seat_number'] ?? null,
        ), 201);
    }

    public function act(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'player_npl_id' => ['required', 'string', 'max:32'],
            'action' => ['required', Rule::in(['rebuy', 'addon', 'addon_void', 'ko', 'unko', 'bonus', 'bonus_void'])],
            'chips' => ['sometimes', 'integer'],
            'label' => ['sometimes', 'nullable', 'string', 'max:80'],
            'idempotency_key' => ['sometimes', 'nullable', 'string', 'max:64'],
        ]);

        $player = $this->tournaments->act($id, $validated['player_npl_id'], $validated['action'], $validated);

        return $this->ok(['player' => $player, 'summary' => $this->tournaments->summary($id)]);
    }

    private function ok(array $data, int $status = 200): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data], $status);
    }
}
