<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * Tournament setup, entries and the money/chips ledger.
 *
 * Ported from EdgeHost's Sichuan module with its good ideas kept — an
 * append-only action ledger, idempotency keys, voids as negative rows, and
 * alive/dead derived from the newest ko/unko — and its gaps closed: add-on
 * and rebuy caps are actually enforced here, where EdgeHost stored
 * `addon_max_per_player` and never checked it.
 */
final class TournamentService
{
    public function __construct(
        private readonly TournamentClockService $clock,
        private readonly TournamentTemplateService $templates,
    ) {}

    /**
     * Precedence: anything the caller passes wins, then the named template,
     * then the saved default template, then the built-in structure. That is
     * what makes "start next week's game in one tap" work while still
     * allowing a one-off tweak.
     */
    public function create(array $data): array
    {
        $template = null;

        if (! empty($data['template_id'])) {
            $template = $this->templates->find((int) $data['template_id']);
        } elseif (! array_key_exists('levels', $data)) {
            $template = $this->templates->default();
        }

        if ($template !== null) {
            $data = $this->templates->toCreatePayload($template, $data);
        }

        $levels = $data['levels'] ?? TournamentClockService::DEFAULT_STRUCTURE;

        if ($levels === []) {
            throw ValidationException::withMessages(['levels' => ['A tournament needs at least one level.']]);
        }

        return DB::transaction(function () use ($data, $levels): array {
            $id = DB::table('tournament_sessions')->insertGetId([
                'uuid' => (string) Str::uuid(),
                'game_session_id' => $data['game_session_id'] ?? null,
                'game_entity_id' => $data['game_entity_id'] ?? null,
                'name' => $data['name'] ?? 'NPL Tournament',
                'venue_name' => $data['venue_name'] ?? null,
                'status' => TournamentClockService::STATUS_DRAFT,
                'starting_stack' => (int) ($data['starting_stack'] ?? 20000),
                'rebuy_chips' => (int) ($data['rebuy_chips'] ?? 20000),
                'rebuy_price_cents' => (int) ($data['rebuy_price_cents'] ?? 0),
                'max_rebuys_per_player' => (int) ($data['max_rebuys_per_player'] ?? 0),
                'addon_chips' => (int) ($data['addon_chips'] ?? 0),
                'addon_price_cents' => (int) ($data['addon_price_cents'] ?? 0),
                'max_addons_per_player' => (int) ($data['max_addons_per_player'] ?? 1),
                'buy_in_price_cents' => (int) ($data['buy_in_price_cents'] ?? 0),
                'ko_bounty_cents' => (int) ($data['ko_bounty_cents'] ?? 0),
                'registration_closes_at_level' => $data['registration_closes_at_level'] ?? null,
                'settings' => isset($data['settings']) ? json_encode($data['settings']) : null,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $this->replaceLevels($id, $levels);

            return $this->show($id);
        }, 3);
    }

    /** Structure edits are refused once play has started. */
    public function updateStructure(int $sessionId, array $levels): array
    {
        $session = $this->clock->session($sessionId);

        if ($session->status !== TournamentClockService::STATUS_DRAFT) {
            throw ValidationException::withMessages([
                'levels' => ['The blind structure cannot be changed after the tournament has started.'],
            ]);
        }

        DB::transaction(fn () => $this->replaceLevels($sessionId, $levels), 3);

        return $this->show($sessionId);
    }

    public function show(int $sessionId): array
    {
        $session = $this->clock->session($sessionId);

        return [
            'session' => [
                'id' => (int) $session->id,
                'uuid' => $session->uuid,
                'name' => $session->name,
                'venue_name' => $session->venue_name,
                'status' => $session->status,
                'game_session_id' => $session->game_session_id,
                'starting_stack' => (int) $session->starting_stack,
                'rebuy_chips' => (int) $session->rebuy_chips,
                'rebuy_price_cents' => (int) $session->rebuy_price_cents,
                'max_rebuys_per_player' => (int) $session->max_rebuys_per_player,
                'addon_chips' => (int) $session->addon_chips,
                'addon_price_cents' => (int) $session->addon_price_cents,
                'max_addons_per_player' => (int) $session->max_addons_per_player,
                'buy_in_price_cents' => (int) $session->buy_in_price_cents,
                'ko_bounty_cents' => (int) $session->ko_bounty_cents,
                'registration_closes_at_level' => $session->registration_closes_at_level,
            ],
            'clock' => $this->clock->state($sessionId),
            'levels' => array_map(
                fn (object $level): array => [
                    'level_no' => (int) $level->level_no,
                    'type' => $level->type,
                    'small_blind' => (int) $level->small_blind,
                    'big_blind' => (int) $level->big_blind,
                    'ante' => (int) $level->ante,
                    'bb_ante' => (int) $level->bb_ante,
                    'duration_min' => (int) $level->duration_min,
                    'sort_order' => (int) $level->sort_order,
                    'note' => $level->note,
                ],
                $this->clock->levels($sessionId),
            ),
            'summary' => $this->summary($sessionId),
        ];
    }

    public function listSessions(): array
    {
        return DB::table('tournament_sessions')
            ->orderByDesc('id')
            ->limit(50)
            ->get()
            ->map(fn (object $row): array => [
                'id' => (int) $row->id,
                'uuid' => $row->uuid,
                'name' => $row->name,
                'venue_name' => $row->venue_name,
                'status' => $row->status,
                'started_at' => $row->started_at,
                'finished_at' => $row->finished_at,
            ])
            ->all();
    }

    /** Register a player and take their buy-in in one step. */
    public function register(int $sessionId, string $nplId, ?string $name = null, ?int $tableNumber = null, ?int $seatNumber = null): array
    {
        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);

        if (! $state['registration_open']) {
            throw ValidationException::withMessages([
                'player_npl_id' => ['Registration has closed for this tournament.'],
            ]);
        }

        return DB::transaction(function () use ($session, $sessionId, $nplId, $name, $tableNumber, $seatNumber, $state): array {
            $existing = DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->first();

            if ($existing !== null) {
                return ['already_registered' => true, 'entry' => $this->presentEntry($existing)];
            }

            DB::table('tournament_entries')->insert([
                'tournament_session_id' => $sessionId,
                'player_npl_id' => $nplId,
                'player_name' => $name,
                'table_number' => $tableNumber,
                'seat_number' => $seatNumber,
                'joined_at' => now(),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $this->recordAction($sessionId, $nplId, 'buy_in', [
                'chips' => (int) $session->starting_stack,
                'price_cents' => (int) $session->buy_in_price_cents,
                'level_index' => $state['level_index'],
            ]);

            $entry = DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->first();

            return ['already_registered' => false, 'entry' => $this->presentEntry($entry)];
        }, 3);
    }

    /**
     * Rebuy / add-on / knockout / bonus. Caps are enforced here — the gap
     * EdgeHost left open.
     */
    public function act(int $sessionId, string $nplId, string $action, array $options = []): array
    {
        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);
        $idempotencyKey = $options['idempotency_key'] ?? null;

        $this->assertRegistered($sessionId, $nplId);

        $attributes = match ($action) {
            'rebuy' => $this->rebuyAttributes($session, $sessionId, $nplId, $state),
            'addon' => $this->addonAttributes($session, $sessionId, $nplId),
            'addon_void' => $this->voidAttributes($sessionId, $nplId, 'addon', 'addon_void'),
            'ko' => ['chips' => 0, 'price_cents' => (int) $session->ko_bounty_cents],
            'unko' => ['chips' => 0, 'price_cents' => -1 * (int) $session->ko_bounty_cents],
            'bonus' => [
                'chips' => (int) ($options['chips'] ?? 0),
                'price_cents' => 0,
                'meta' => ['label' => $options['label'] ?? 'Bonus'],
            ],
            'bonus_void' => $this->voidAttributes($sessionId, $nplId, 'bonus', 'bonus_void'),
            default => throw ValidationException::withMessages(['action' => ["Unsupported action [{$action}]."]]),
        };

        $this->recordAction($sessionId, $nplId, $action, $attributes + [
            'level_index' => $state['level_index'],
            'idempotency_key' => $idempotencyKey,
        ]);

        return $this->playerState($sessionId, $nplId);
    }

    /** Roster with derived chips, spend and alive/dead. */
    public function players(int $sessionId): array
    {
        $session = $this->clock->session($sessionId);

        $entries = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->orderBy('table_number')
            ->orderBy('seat_number')
            ->get();

        $totals = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->selectRaw('player_npl_id, SUM(chips) as chips, SUM(price_cents) as spend')
            ->groupBy('player_npl_id')
            ->get()
            ->keyBy('player_npl_id');

        $knockedOut = $this->knockedOutMap($sessionId);

        $counts = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->whereIn('action', ['rebuy', 'addon'])
            ->selectRaw('player_npl_id, action, COUNT(*) as total')
            ->groupBy('player_npl_id', 'action')
            ->get();

        $byPlayer = [];
        foreach ($counts as $row) {
            $byPlayer[$row->player_npl_id][$row->action] = (int) $row->total;
        }

        return $entries->map(function (object $entry) use ($totals, $knockedOut, $byPlayer): array {
            $npl = $entry->player_npl_id;
            $total = $totals->get($npl);

            return [
                'player_npl_id' => $npl,
                'player_name' => $entry->player_name,
                'table_number' => $entry->table_number,
                'seat_number' => $entry->seat_number,
                'chips' => (int) ($total->chips ?? 0),
                'spend_cents' => (int) ($total->spend ?? 0),
                'rebuys' => $byPlayer[$npl]['rebuy'] ?? 0,
                'addons' => $byPlayer[$npl]['addon'] ?? 0,
                'knocked_out' => $knockedOut[$npl] ?? false,
                'joined_at' => $entry->joined_at,
            ];
        })->values()->all();
    }

    public function summary(int $sessionId): array
    {
        $players = $this->players($sessionId);
        $alive = array_filter($players, fn (array $player): bool => ! $player['knocked_out']);

        return [
            'total_players' => count($players),
            'active_players' => count($alive),
            'total_chips' => array_sum(array_column($players, 'chips')),
            'revenue_cents' => array_sum(array_column($players, 'spend_cents')),
            'total_rebuys' => array_sum(array_column($players, 'rebuys')),
            'total_addons' => array_sum(array_column($players, 'addons')),
            'average_stack' => count($alive) > 0
                ? (int) round(array_sum(array_column($players, 'chips')) / count($alive))
                : 0,
        ];
    }

    // ---- internals -------------------------------------------------------

    private function rebuyAttributes(object $session, int $sessionId, string $nplId, array $state): array
    {
        if (! $state['registration_open']) {
            throw ValidationException::withMessages(['action' => ['Rebuys have closed for this tournament.']]);
        }

        $cap = (int) $session->max_rebuys_per_player;

        if ($cap > 0) {
            $used = DB::table('tournament_actions')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->where('action', 'rebuy')
                ->count();

            if ($used >= $cap) {
                throw ValidationException::withMessages([
                    'action' => [sprintf('This player has used all %d rebuys.', $cap)],
                ]);
            }
        }

        return ['chips' => (int) $session->rebuy_chips, 'price_cents' => (int) $session->rebuy_price_cents];
    }

    private function addonAttributes(object $session, int $sessionId, string $nplId): array
    {
        $cap = (int) $session->max_addons_per_player;

        if ($cap > 0) {
            $used = DB::table('tournament_actions')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->where('action', 'addon')
                ->count()
                - DB::table('tournament_actions')
                    ->where('tournament_session_id', $sessionId)
                    ->where('player_npl_id', $nplId)
                    ->where('action', 'addon_void')
                    ->count();

            if ($used >= $cap) {
                throw ValidationException::withMessages([
                    'action' => [sprintf('This player has used all %d add-ons.', $cap)],
                ]);
            }
        }

        return ['chips' => (int) $session->addon_chips, 'price_cents' => (int) $session->addon_price_cents];
    }

    /** A void mirrors the most recent matching row with negated amounts. */
    private function voidAttributes(int $sessionId, string $nplId, string $target, string $voidAction): array
    {
        $last = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->where('action', $target)
            ->orderByDesc('id')
            ->first();

        if ($last === null) {
            throw ValidationException::withMessages([
                'action' => ["There is no {$target} to cancel for this player."],
            ]);
        }

        return [
            'chips' => -1 * (int) $last->chips,
            'price_cents' => -1 * (int) $last->price_cents,
            'meta' => ['voids_action_id' => (int) $last->id],
        ];
    }

    private function recordAction(int $sessionId, string $nplId, string $action, array $attributes): void
    {
        $row = [
            'tournament_session_id' => $sessionId,
            'player_npl_id' => $nplId,
            'action' => $action,
            'chips' => (int) ($attributes['chips'] ?? 0),
            'price_cents' => (int) ($attributes['price_cents'] ?? 0),
            'level_index' => $attributes['level_index'] ?? null,
            'idempotency_key' => $attributes['idempotency_key'] ?? null,
            'meta' => isset($attributes['meta']) ? json_encode($attributes['meta']) : null,
            'created_at' => now(),
            'updated_at' => now(),
        ];

        try {
            DB::table('tournament_actions')->insert($row);
        } catch (\Illuminate\Database\QueryException $e) {
            // A repeat of a keyed action is the same action, not a new one.
            if ($row['idempotency_key'] === null) {
                throw $e;
            }
        }
    }

    /** @return array<string, bool> npl_id => knocked out */
    private function knockedOutMap(int $sessionId): array
    {
        $latest = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->whereIn('action', ['ko', 'unko'])
            ->selectRaw('player_npl_id, MAX(id) as last_id')
            ->groupBy('player_npl_id')
            ->pluck('last_id', 'player_npl_id');

        if ($latest->isEmpty()) {
            return [];
        }

        $actions = DB::table('tournament_actions')
            ->whereIn('id', $latest->values())
            ->pluck('action', 'id');

        $map = [];
        foreach ($latest as $npl => $id) {
            $map[$npl] = ($actions[$id] ?? null) === 'ko';
        }

        return $map;
    }

    private function playerState(int $sessionId, string $nplId): array
    {
        foreach ($this->players($sessionId) as $player) {
            if ($player['player_npl_id'] === $nplId) {
                return $player;
            }
        }

        return ['player_npl_id' => $nplId];
    }

    private function assertRegistered(int $sessionId, string $nplId): void
    {
        $exists = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->exists();

        if (! $exists) {
            throw ValidationException::withMessages([
                'player_npl_id' => ['That player is not registered in this tournament.'],
            ]);
        }
    }

    private function presentEntry(object $entry): array
    {
        return [
            'player_npl_id' => $entry->player_npl_id,
            'player_name' => $entry->player_name,
            'table_number' => $entry->table_number,
            'seat_number' => $entry->seat_number,
            'joined_at' => $entry->joined_at,
        ];
    }

    private function replaceLevels(int $sessionId, array $levels): void
    {
        DB::table('tournament_levels')->where('tournament_session_id', $sessionId)->delete();

        $rows = [];
        foreach (array_values($levels) as $order => $level) {
            $rows[] = [
                'tournament_session_id' => $sessionId,
                'level_no' => (int) ($level['level_no'] ?? $order + 1),
                'type' => in_array($level['type'] ?? 'blind', ['blind', 'break'], true) ? $level['type'] : 'blind',
                'small_blind' => (int) ($level['small_blind'] ?? 0),
                'big_blind' => (int) ($level['big_blind'] ?? 0),
                'ante' => (int) ($level['ante'] ?? 0),
                'bb_ante' => (int) ($level['bb_ante'] ?? 0),
                'duration_min' => max(1, (int) ($level['duration_min'] ?? 20)),
                'sort_order' => $order,
                'note' => $level['note'] ?? null,
                'created_at' => now(),
                'updated_at' => now(),
            ];
        }

        foreach (array_chunk($rows, 100) as $chunk) {
            DB::table('tournament_levels')->insert($chunk);
        }
    }
}
