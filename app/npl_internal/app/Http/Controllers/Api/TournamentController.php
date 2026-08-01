<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Tournament\TournamentBroadcaster;
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
        private readonly TournamentBroadcaster $broadcaster,
    ) {}

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            // 'cash' = the same desk with no clock, no ladder, no cut-offs.
            'game_type' => ['sometimes', Rule::in(['tournament', 'cash'])],
            // Optional: an empty name defaults to "date — venue" downstream,
            // because most nights that IS the name.
            'name' => ['sometimes', 'nullable', 'string', 'max:160'],
            'template_id' => ['sometimes', 'nullable', 'integer'],
            'venue_name' => ['sometimes', 'nullable', 'string', 'max:160'],
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
            'game_entity_id' => ['sometimes', 'nullable', 'integer'],
            'starting_stack' => ['sometimes', 'integer', 'min:1'],
            'rebuy_chips' => ['sometimes', 'integer', 'min:0'],
            'rebuy_price_cents' => ['sometimes', 'integer', 'min:0'],
            'rebuy_tiers' => ['sometimes', 'array', 'max:4'],
            'rebuy_tiers.*.price_cents' => ['required_with:rebuy_tiers', 'integer', 'min:0'],
            'rebuy_tiers.*.chips' => ['required_with:rebuy_tiers', 'integer', 'min:1'],
            'max_rebuys_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'addon_chips' => ['sometimes', 'integer', 'min:0'],
            'addon_price_cents' => ['sometimes', 'integer', 'min:0'],
            'addon_tiers' => ['sometimes', 'array', 'max:4'],
            'addon_tiers.*.price_cents' => ['required_with:addon_tiers', 'integer', 'min:0'],
            'addon_tiers.*.chips' => ['required_with:addon_tiers', 'integer', 'min:1'],
            'max_addons_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'buy_in_price_cents' => ['sometimes', 'integer', 'min:0'],
            'ko_bounty_cents' => ['sometimes', 'integer', 'min:0'],
            // Required for tournaments: the desk has to decide when the
            // doors shut. Cash games have no levels — nothing ever cuts off.
            'registration_closes_at_level' => ['required_unless:game_type,cash', 'integer', 'min:1'],
            'addon_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'rebuy_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'jackpot_enabled' => ['sometimes', 'boolean'],
            'jackpot_price_cents' => ['sometimes', 'integer', 'min:0'],
            'jackpot_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            // Cash games cut off by TIME, not levels: minutes after Start
            // game. Blank = open until the game finishes.
            'cash_reg_close_min' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1440'],
            'cash_jackpot_close_min' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1440'],
            'seats_per_table' => ['sometimes', 'integer', 'min:2', 'max:10'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],

            // Generate the ladder from a pattern instead of typing it out.
            'structure' => ['sometimes', 'array'],
            'structure.levels' => ['sometimes', 'integer', 'min:1', 'max:60'],
            'structure.duration_min' => ['sometimes', 'integer', 'min:1', 'max:180'],
            'structure.small_blind' => ['sometimes', 'integer', 'min:1'],
            'structure.big_blind_multiple' => ['sometimes', 'numeric', 'min:1'],
            'structure.mode' => ['sometimes', Rule::in(['add', 'multiply'])],
            'structure.step' => ['sometimes', 'numeric', 'min:0.1'],
            'structure.break_every' => ['sometimes', 'integer', 'min:0', 'max:20'],
            'structure.break_duration_min' => ['sometimes', 'integer', 'min:1', 'max:120'],
            'structure.ante_from_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'structure.ante_as_big_blind' => ['sometimes', 'boolean'],

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

    /** Draft-only settings edit — the prep screen re-opened. */
    public function update(Request $request, int $id): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['sometimes', 'nullable', 'string', 'max:160'],
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
            'starting_stack' => ['sometimes', 'integer', 'min:1'],
            'rebuy_tiers' => ['sometimes', 'array', 'max:4'],
            'rebuy_tiers.*.price_cents' => ['required_with:rebuy_tiers', 'integer', 'min:0'],
            'rebuy_tiers.*.chips' => ['required_with:rebuy_tiers', 'integer', 'min:1'],
            'max_rebuys_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'addon_tiers' => ['sometimes', 'array', 'max:4'],
            'addon_tiers.*.price_cents' => ['required_with:addon_tiers', 'integer', 'min:0'],
            'addon_tiers.*.chips' => ['required_with:addon_tiers', 'integer', 'min:1'],
            'max_addons_per_player' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'buy_in_price_cents' => ['sometimes', 'integer', 'min:0'],
            'ko_bounty_cents' => ['sometimes', 'integer', 'min:0'],
            'registration_closes_at_level' => ['sometimes', 'integer', 'min:1'],
            'addon_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'rebuy_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'jackpot_enabled' => ['sometimes', 'boolean'],
            'jackpot_price_cents' => ['sometimes', 'integer', 'min:0'],
            'jackpot_closes_at_level' => ['sometimes', 'nullable', 'integer', 'min:1'],
            // Cash games cut off by TIME, not levels: minutes after Start
            // game. Blank = open until the game finishes.
            'cash_reg_close_min' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1440'],
            'cash_jackpot_close_min' => ['sometimes', 'nullable', 'integer', 'min:1', 'max:1440'],
            'seats_per_table' => ['sometimes', 'integer', 'min:2', 'max:10'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],
            'levels' => ['sometimes', 'array', 'min:1'],
            'levels.*.type' => ['sometimes', Rule::in(['blind', 'break'])],
            'levels.*.small_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.big_blind' => ['sometimes', 'integer', 'min:0'],
            'levels.*.duration_min' => ['sometimes', 'integer', 'min:1', 'max:600'],
        ]);

        return $this->ok($this->tournaments->updateDraft($id, $validated));
    }

    public function start(int $id): JsonResponse
    {
        $state = $this->clock->start($id);
        // Tell the cloud so every watching phone updates at once.
        $this->broadcaster->publish($id);

        return $this->ok(['clock' => $state]);
    }

    public function pause(int $id): JsonResponse
    {
        $state = $this->clock->pause($id);
        // Tell the cloud so every watching phone updates at once.
        $this->broadcaster->publish($id);

        return $this->ok(['clock' => $state]);
    }

    public function resume(int $id): JsonResponse
    {
        $state = $this->clock->resume($id);
        // Tell the cloud so every watching phone updates at once.
        $this->broadcaster->publish($id);

        return $this->ok(['clock' => $state]);
    }

    public function nextLevel(int $id): JsonResponse
    {
        $state = $this->clock->nextLevel($id);
        // Tell the cloud so every watching phone updates at once.
        $this->broadcaster->publish($id);

        return $this->ok(['clock' => $state]);
    }

    public function previousLevel(int $id): JsonResponse
    {
        $state = $this->clock->previousLevel($id);
        // Tell the cloud so every watching phone updates at once.
        $this->broadcaster->publish($id);

        return $this->ok(['clock' => $state]);
    }

    private function ok(array $data, int $status = 200): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data], $status);
    }
}
