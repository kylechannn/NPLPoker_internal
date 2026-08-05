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
     * The room's single unfinished desk session — draft, running or paused,
     * tournament or cash. Null when the room is idle. This is what refuses a
     * second create and what the sidebar admin QR renders: one session at a
     * time means one admin QR at a time.
     */
    public function activeSession(): ?object
    {
        return DB::table('tournament_sessions')
            ->where('status', '!=', TournamentClockService::STATUS_FINISHED)
            ->orderByDesc('id')
            ->first();
    }

    /**
     * Abandon a mistaken draft. Only a draft with NO recorded entries can be
     * discarded — once money hits the ledger the only exit is Finish, because
     * finishing is what reconciles the books with the cloud. Without this, a
     * wrongly-created draft would hold the one-session slot forever.
     */
    public function discardDraft(int $sessionId): array
    {
        $session = $this->clock->session($sessionId);

        if ($session->status !== TournamentClockService::STATUS_DRAFT) {
            throw ValidationException::withMessages([
                'session' => ['Only a draft session can be discarded — finish the game instead.'],
            ]);
        }

        $entries = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->count();

        if ($entries > 0) {
            throw ValidationException::withMessages([
                'session' => ['Players have already bought in — finish the game instead of discarding it.'],
            ]);
        }

        DB::transaction(function () use ($sessionId): void {
            DB::table('tournament_levels')->where('tournament_session_id', $sessionId)->delete();
            DB::table('tournament_sessions')->where('id', $sessionId)->delete();
        });

        return ['discarded' => true];
    }

    /**
     * Precedence: anything the caller passes wins, then the named template,
     * then the saved default template, then the built-in structure. That is
     * what makes "start next week's game in one tap" work while still
     * allowing a one-off tweak.
     */
    public function create(array $data): array
    {
        // ONE desk at a time: the room runs a single live session — cash or
        // tournament — and the admin QR belongs to it. A second create is
        // refused until the current one finishes (or its empty draft is
        // discarded); without this rule two QR codes could exist at once.
        $active = $this->activeSession();

        if ($active !== null) {
            throw ValidationException::withMessages([
                'session' => [sprintf(
                    '"%s" is still open — finish that session before creating a new one.',
                    (string) ($active->name ?? 'The current session'),
                )],
            ]);
        }

        // A cash game is the same desk minus the clock: no blind ladder, no
        // templates, and every cut-off blank — open until the game finishes.
        $isCash = ($data['game_type'] ?? 'tournament') === 'cash';

        $template = null;

        if (! $isCash) {
            if (! empty($data['template_id'])) {
                $template = $this->templates->find((int) $data['template_id']);
            } elseif (! array_key_exists('levels', $data)) {
                $template = $this->templates->default();
            }
        }

        if ($template !== null) {
            $data = $this->templates->toCreatePayload($template, $data);
        }

        // A pattern is the usual way a venue describes its structure, so the
        // preset screen can send one instead of twenty hand-typed rows. Cash
        // games get one silent placeholder level: the clock/gate math stays
        // intact, and the clock is simply never started.
        $levels = $isCash
            ? [['level_no' => 1, 'type' => 'blind', 'small_blind' => 0, 'big_blind' => 0, 'duration_min' => 480]]
            : (isset($data['structure']) && is_array($data['structure'])
                ? app(BlindStructureGenerator::class)->generate($data['structure'])
                : ($data['levels'] ?? TournamentClockService::DEFAULT_STRUCTURE));

        if ($levels === []) {
            throw ValidationException::withMessages(['levels' => ['A tournament needs at least one level.']]);
        }

        // The registration cut-off is the one setting the desk must decide:
        // everything downstream (online registration closing, the countdown
        // players watch, what a scan is allowed to do) hangs off it. Cash
        // games have no levels to cut off at — everything stays open.
        $registrationCloses = $isCash ? null : ($data['registration_closes_at_level'] ?? null);

        if ($registrationCloses === null && ! $isCash) {
            throw ValidationException::withMessages([
                'registration_closes_at_level' => ['Set the level registration closes at before opening the session.'],
            ]);
        }

        if (! $isCash) {
            $this->assertCutOffWithinStructure('registration_closes_at_level', $registrationCloses, $levels);

            foreach (['addon_closes_at_level', 'rebuy_closes_at_level', 'jackpot_closes_at_level'] as $field) {
                // Optional — but once entered they have to be reachable, or
                // the desk has set a rule that silently never fires.
                if (($data[$field] ?? null) !== null) {
                    $this->assertCutOffWithinStructure($field, (int) $data[$field], $levels);
                }
            }
        }

        // "Tue 29 Jul — NPL Sydney" is what most nights are actually called;
        // a typed name is the exception, not the rule.
        $name = trim((string) ($data['name'] ?? ''));
        if ($name === '') {
            $name = trim(sprintf(
                '%s — %s',
                now()->format('D j M Y'),
                (string) ($data['venue_name'] ?? ($isCash ? 'NPL Cash Game' : 'NPL Tournament')),
            ), ' —');
        }

        // Tiered add-ons; the legacy single pair becomes tier one so old
        // callers and old sessions keep working unchanged.
        $tiers = collect($data['addon_tiers'] ?? [])
            ->map(fn (array $tier): array => [
                'price_cents' => (int) $tier['price_cents'],
                'chips' => (int) $tier['chips'],
            ])
            ->values();

        if ($tiers->isEmpty() && (int) ($data['addon_chips'] ?? 0) > 0) {
            $tiers = collect([[
                'price_cents' => (int) ($data['addon_price_cents'] ?? 0),
                'chips' => (int) ($data['addon_chips'] ?? 0),
            ]]);
        }

        // Rebuys tier the same way.
        $rebuyTiers = collect($data['rebuy_tiers'] ?? [])
            ->map(fn (array $tier): array => [
                'price_cents' => (int) $tier['price_cents'],
                'chips' => (int) $tier['chips'],
            ])
            ->values();

        if ($rebuyTiers->isEmpty() && (int) ($data['rebuy_chips'] ?? 0) > 0) {
            $rebuyTiers = collect([[
                'price_cents' => (int) ($data['rebuy_price_cents'] ?? 0),
                'chips' => (int) ($data['rebuy_chips'] ?? 0),
            ]]);
        }

        return DB::transaction(function () use ($data, $levels, $name, $tiers, $rebuyTiers, $isCash, $registrationCloses): array {
            $id = DB::table('tournament_sessions')->insertGetId([
                'uuid' => (string) Str::uuid(),
                'game_type' => $isCash ? 'cash' : 'tournament',
                'game_session_id' => $data['game_session_id'] ?? null,
                'game_entity_id' => $data['game_entity_id'] ?? null,
                'name' => $name,
                'venue_name' => $data['venue_name'] ?? null,
                'status' => TournamentClockService::STATUS_DRAFT,
                'starting_stack' => (int) ($data['starting_stack'] ?? 20000),
                'rebuy_chips' => (int) ($rebuyTiers->first()['chips'] ?? $data['rebuy_chips'] ?? 20000),
                'rebuy_price_cents' => (int) ($rebuyTiers->first()['price_cents'] ?? $data['rebuy_price_cents'] ?? 0),
                'rebuy_tiers' => $rebuyTiers->isNotEmpty() ? $rebuyTiers->toJson() : null,
                'max_rebuys_per_player' => (int) ($data['max_rebuys_per_player'] ?? 0),
                'addon_chips' => (int) ($tiers->first()['chips'] ?? $data['addon_chips'] ?? 0),
                'addon_price_cents' => (int) ($tiers->first()['price_cents'] ?? $data['addon_price_cents'] ?? 0),
                'addon_tiers' => $tiers->isNotEmpty() ? $tiers->toJson() : null,
                'max_addons_per_player' => (int) ($data['max_addons_per_player'] ?? 1),
                'buy_in_price_cents' => (int) ($data['buy_in_price_cents'] ?? 0),
                'ko_bounty_cents' => (int) ($data['ko_bounty_cents'] ?? 0),
                'registration_closes_at_level' => $registrationCloses !== null ? (int) $registrationCloses : null,
                'addon_closes_at_level' => $data['addon_closes_at_level'] ?? null,
                'rebuy_closes_at_level' => $data['rebuy_closes_at_level'] ?? null,
                'jackpot_enabled' => (bool) ($data['jackpot_enabled'] ?? false),
                'jackpot_price_cents' => (int) ($data['jackpot_price_cents'] ?? 0),
                'jackpot_closes_at_level' => $data['jackpot_closes_at_level'] ?? null,
                // Cash time gates — minutes after Start game; null = never.
                'cash_reg_close_min' => $isCash ? ($data['cash_reg_close_min'] ?? null) : null,
                'cash_jackpot_close_min' => $isCash ? ($data['cash_jackpot_close_min'] ?? null) : null,
                'seats_per_table' => (int) ($data['seats_per_table'] ?? 8),
                'venue_id' => $data['venue_id'] ?? null,
                'settings' => isset($data['settings']) ? json_encode($data['settings']) : null,
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $this->replaceLevels($id, $levels);

            return $this->show($id);
        }, 3);
    }

    /** @param  list<array<string, mixed>>  $levels */
    private function assertCutOffWithinStructure(string $field, int $value, array $levels): void
    {
        // A cut-off is a position in the ladder — it is compared against
        // `current_level_index`, which counts breaks too. Validating against
        // the printed level_no would be wrong the moment a break exists.
        $highest = count($levels);

        if ($value < 1 || $value > $highest) {
            throw ValidationException::withMessages([
                $field => [sprintf('Cut-off must be between 1 and %d (the structure has %d levels).', $highest, $highest)],
            ]);
        }
    }

    /**
     * Re-open the preparation screen for a draft: every setting stays
     * editable right up until Start is pressed — after that, prices and
     * structure are locked and the ledger speaks.
     */
    public function updateDraft(int $sessionId, array $data): array
    {
        $session = $this->clock->session($sessionId);

        if ($session->status !== TournamentClockService::STATUS_DRAFT) {
            throw ValidationException::withMessages([
                'session' => ['Settings are locked once the tournament has started.'],
            ]);
        }

        $levels = isset($data['levels']) && is_array($data['levels']) && $data['levels'] !== []
            ? $data['levels']
            : null;

        if (isset($data['registration_closes_at_level'])) {
            $ladder = $levels ?? $this->clock->levels($sessionId);
            $this->assertCutOffWithinStructure('registration_closes_at_level', (int) $data['registration_closes_at_level'], (array) $ladder);
        }

        $tiers = collect($data['addon_tiers'] ?? [])
            ->map(fn (array $tier): array => ['price_cents' => (int) $tier['price_cents'], 'chips' => (int) $tier['chips']])
            ->values();
        $rebuyTiers = collect($data['rebuy_tiers'] ?? [])
            ->map(fn (array $tier): array => ['price_cents' => (int) $tier['price_cents'], 'chips' => (int) $tier['chips']])
            ->values();

        $name = trim((string) ($data['name'] ?? ''));

        DB::transaction(function () use ($sessionId, $session, $data, $levels, $tiers, $rebuyTiers, $name): void {
            $update = [
                'updated_at' => now(),
            ];

            // Free-form settings (room-display extras like chip
            // denominations and the prize pool line) merge over what is
            // already stored, so partial edits never wipe other keys.
            if (isset($data['settings']) && is_array($data['settings'])) {
                $existing = json_decode((string) ($session->settings ?? ''), true);
                $update['settings'] = json_encode(array_merge(is_array($existing) ? $existing : [], $data['settings']));
            }

            if ($name !== '') {
                $update['name'] = $name;
            }

            foreach ([
                'game_session_id', 'starting_stack', 'max_rebuys_per_player', 'max_addons_per_player',
                'buy_in_price_cents', 'ko_bounty_cents', 'registration_closes_at_level',
                'addon_closes_at_level', 'rebuy_closes_at_level', 'jackpot_closes_at_level',
                'jackpot_price_cents', 'seats_per_table', 'venue_id',
                'cash_reg_close_min', 'cash_jackpot_close_min',
            ] as $field) {
                if (array_key_exists($field, $data)) {
                    $update[$field] = $data[$field];
                }
            }

            if (array_key_exists('jackpot_enabled', $data)) {
                $update['jackpot_enabled'] = (bool) $data['jackpot_enabled'];
            }

            if ($rebuyTiers->isNotEmpty()) {
                $update['rebuy_tiers'] = $rebuyTiers->toJson();
                $update['rebuy_price_cents'] = (int) $rebuyTiers->first()['price_cents'];
                $update['rebuy_chips'] = (int) $rebuyTiers->first()['chips'];
            }

            if ($tiers->isNotEmpty()) {
                $update['addon_tiers'] = $tiers->toJson();
                $update['addon_price_cents'] = (int) $tiers->first()['price_cents'];
                $update['addon_chips'] = (int) $tiers->first()['chips'];
            }

            DB::table('tournament_sessions')->where('id', $sessionId)->update($update);

            if ($levels !== null) {
                $this->replaceLevels($sessionId, $levels);
            }
        }, 3);

        return $this->show($sessionId);
    }

    /**
     * The chips/prize rail text, merged into the settings bag whatever the
     * session status — unlike updateDraft, this stays open after Start so
     * the director can keep the prize pool current as rebuys land.
     */
    public function updateDisplay(int $sessionId, array $data): array
    {
        $session = $this->clock->session($sessionId);

        $existing = json_decode((string) ($session->settings ?? ''), true);
        $merged = array_merge(
            is_array($existing) ? $existing : [],
            array_intersect_key($data, ['chip_denominations' => true, 'prize_pool_text' => true]),
        );

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'settings' => json_encode($merged),
            'updated_at' => now(),
        ]);

        $denoms = trim((string) ($merged['chip_denominations'] ?? ''));
        $prize = trim((string) ($merged['prize_pool_text'] ?? ''));

        return [
            'display' => [
                'chip_denominations' => $denoms !== '' ? $denoms : null,
                'prize_pool_text' => $prize !== '' ? $prize : null,
            ],
        ];
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
                'game_type' => $session->game_type ?? 'tournament',
                'game_session_id' => $session->game_session_id,
                'starting_stack' => (int) $session->starting_stack,
                'rebuy_chips' => (int) $session->rebuy_chips,
                'rebuy_price_cents' => (int) $session->rebuy_price_cents,
                'rebuy_tiers' => self::rebuyTiers($session),
                'max_rebuys_per_player' => (int) $session->max_rebuys_per_player,
                'addon_chips' => (int) $session->addon_chips,
                'addon_price_cents' => (int) $session->addon_price_cents,
                'addon_tiers' => self::addonTiers($session),
                'max_addons_per_player' => (int) $session->max_addons_per_player,
                'buy_in_price_cents' => (int) $session->buy_in_price_cents,
                'ko_bounty_cents' => (int) $session->ko_bounty_cents,
                'registration_closes_at_level' => $session->registration_closes_at_level,
                'addon_closes_at_level' => $session->addon_closes_at_level,
                'rebuy_closes_at_level' => $session->rebuy_closes_at_level,
                'jackpot_closes_at_level' => $session->jackpot_closes_at_level,
                'jackpot_enabled' => (bool) $session->jackpot_enabled,
                'jackpot_price_cents' => (int) $session->jackpot_price_cents,
                'seats_per_table' => (int) $session->seats_per_table,
                'settings' => (function () use ($session): array {
                    $decoded = json_decode((string) ($session->settings ?? ''), true);

                    return is_array($decoded) ? $decoded : [];
                })(),
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
    public function register(int $sessionId, string $nplId, ?string $name = null, ?int $tableNumber = null, ?int $seatNumber = null, array $extras = []): array
    {
        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);

        if (! $state['registration_open']) {
            throw ValidationException::withMessages([
                'player_npl_id' => ['Registration has closed for this tournament.'],
            ]);
        }

        return DB::transaction(function () use ($session, $sessionId, $nplId, $name, $tableNumber, $seatNumber, $state, $extras): array {
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

            // A voucher-covered entry books at zero so the desk's takings
            // stay honest; the voucher code rides in the action meta.
            $this->recordAction($sessionId, $nplId, 'buy_in', [
                'chips' => (int) $session->starting_stack,
                'price_cents' => array_key_exists('price_cents', $extras)
                    ? (int) $extras['price_cents']
                    : (int) $session->buy_in_price_cents,
                'level_index' => $state['level_index'],
                'meta' => $extras['meta'] ?? null,
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

        // Enforced here as well as at the desk: this method is reachable
        // straight from the action API, and a cut-off that only holds on one
        // route is not a cut-off.
        if (in_array($action, ['rebuy', 'addon'], true)) {
            $gate = app(TournamentGateService::class)->check($sessionId, $action, true, $session, $state);

            if (! $gate['allowed']) {
                throw ValidationException::withMessages(['action' => [$gate['reason']]]);
            }
        }

        $attributes = match ($action) {
            'rebuy' => $this->rebuyAttributes($session, $sessionId, $nplId, $state, $options),
            'addon' => $this->addonAttributes($session, $sessionId, $nplId, $options),
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

    private function rebuyAttributes(object $session, int $sessionId, string $nplId, array $state, array $options = []): array
    {
        // Whether rebuys are still open is TournamentGateService's call, not
        // this method's — rebuys have their own cut-off and routinely outlive
        // registration, so tying them together here would silently override
        // what the desk set on the preset screen. Caps stay here because they
        // are per-player, not per-tournament.
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

        $tiers = self::rebuyTiers($session);
        $tierIndex = isset($options['tier']) ? (int) $options['tier'] : 0;
        $tier = $tiers[$tierIndex] ?? $tiers[0] ?? null;

        if ($tier !== null) {
            return ['chips' => (int) $tier['chips'], 'price_cents' => (int) $tier['price_cents']];
        }

        return ['chips' => (int) $session->rebuy_chips, 'price_cents' => (int) $session->rebuy_price_cents];
    }

    /**
     * The session's rebuy tiers; old sessions fall back to the single
     * legacy pair.
     *
     * @return list<array{price_cents: int, chips: int}>
     */
    public static function rebuyTiers(object $session): array
    {
        $raw = $session->rebuy_tiers ?? null;
        $tiers = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);

        if (is_array($tiers) && $tiers !== []) {
            return array_values(array_map(fn (array $tier): array => [
                'price_cents' => (int) ($tier['price_cents'] ?? 0),
                'chips' => (int) ($tier['chips'] ?? 0),
            ], $tiers));
        }

        if ((int) $session->rebuy_chips > 0) {
            return [[
                'price_cents' => (int) $session->rebuy_price_cents,
                'chips' => (int) $session->rebuy_chips,
            ]];
        }

        return [];
    }

    private function addonAttributes(object $session, int $sessionId, string $nplId, array $options = []): array
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

        $tiers = self::addonTiers($session);
        $tierIndex = isset($options['tier']) ? (int) $options['tier'] : 0;
        $tier = $tiers[$tierIndex] ?? $tiers[0] ?? null;

        if ($tier !== null) {
            return ['chips' => (int) $tier['chips'], 'price_cents' => (int) $tier['price_cents']];
        }

        return ['chips' => (int) $session->addon_chips, 'price_cents' => (int) $session->addon_price_cents];
    }

    /**
     * The session's add-on tiers, oldest sessions falling back to the
     * single legacy pair.
     *
     * @return list<array{price_cents: int, chips: int}>
     */
    public static function addonTiers(object $session): array
    {
        $raw = $session->addon_tiers ?? null;
        $tiers = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);

        if (is_array($tiers) && $tiers !== []) {
            return array_values(array_map(fn (array $tier): array => [
                'price_cents' => (int) ($tier['price_cents'] ?? 0),
                'chips' => (int) ($tier['chips'] ?? 0),
            ], $tiers));
        }

        if ((int) $session->addon_chips > 0) {
            return [[
                'price_cents' => (int) $session->addon_price_cents,
                'chips' => (int) $session->addon_chips,
            ]];
        }

        return [];
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
