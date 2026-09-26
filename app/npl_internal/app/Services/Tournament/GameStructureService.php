<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use Illuminate\Support\Facades\DB;

/**
 * The game structure defaults every desk opens its games from.
 *
 * The desk no longer has a preparation screen: a tournament director (or
 * any admin) presses Open on tonight's session and lands straight in
 * registration, with the prices, tiers, cut-offs and blind ladder the
 * super admin saved on the NPL cloud. This service mirrors that base
 * setup locally (so a night still opens with the internet down), turns it
 * into the payload TournamentService::create expects, and falls back to a
 * built-in structure until the super admin has saved one.
 */
final class GameStructureService
{
    public const TYPE_TOURNAMENT = 'tournament';

    public const TYPE_CASH = 'cash';

    public const TYPES = [self::TYPE_TOURNAMENT, self::TYPE_CASH];

    private const TABLE = 'game_structure_defaults';

    /** The ladder the built-in tournament default is generated from. */
    private const BUILT_IN_PATTERN = [
        'levels' => 18,
        'duration_min' => 20,
        'small_blind' => 100,
        'big_blind_multiple' => 2,
        'mode' => 'multiply',
        'step' => 1.5,
        'break_every' => 6,
        'break_duration_min' => 15,
        'ante_from_level' => 5,
        'ante_as_big_blind' => true,
    ];

    public function __construct(
        private readonly CloudClient $cloud,
        private readonly BlindStructureGenerator $generator,
    ) {}

    /**
     * What the desk runs on until the super admin has saved a default —
     * the same numbers the retired preparation screen opened with.
     *
     * @return array{settings: array<string, mixed>, levels: ?list<array<string, mixed>>}
     */
    public function builtIn(string $type): array
    {
        if ($type === self::TYPE_CASH) {
            return [
                'settings' => [
                    'buy_in_price_cents' => 10000,
                    'starting_stack' => 10000,
                    'seats_per_table' => 8,
                    'topups_enabled' => true,
                    'rebuy_price_cents' => 10000,
                    'rebuy_chips' => 10000,
                    'jackpot_enabled' => false,
                    'jackpot_price_cents' => 500,
                    'cash_reg_close_min' => 0,
                    'cash_jackpot_close_min' => 0,
                ],
                'levels' => null,
            ];
        }

        return [
            'settings' => [
                'seats_per_table' => 8,
                'starting_stack' => 20000,
                'buy_in_price_cents' => 10000,
                'rebuy_tiers' => [['price_cents' => 10000, 'chips' => 20000]],
                'max_rebuys_per_player' => 0,
                'addon_tiers' => [['price_cents' => 5000, 'chips' => 30000]],
                'max_addons_per_player' => 1,
                'jackpot_enabled' => true,
                'jackpot_price_cents' => 1000,
                'registration_closes_at_level' => 6,
                'rebuy_closes_at_level' => null,
                'addon_closes_at_level' => null,
                'jackpot_closes_at_level' => null,
                'chip_denominations' => '',
                'pattern' => self::BUILT_IN_PATTERN,
            ],
            'levels' => $this->generator->generate(self::BUILT_IN_PATTERN),
        ];
    }

    /**
     * The default in force for one desk kind: the mirrored cloud save when
     * there is one, the built-in structure otherwise.
     *
     * @return array<string, mixed>
     */
    public function current(string $type): array
    {
        $this->assertType($type);

        $row = DB::table(self::TABLE)->where('game_type', $type)->first();

        if ($row === null) {
            return $this->builtIn($type) + [
                'game_type' => $type,
                'source' => 'built_in',
                'cloud_updated_at' => null,
                'updated_by' => null,
                'pulled_at' => null,
            ];
        }

        $settings = json_decode((string) $row->settings, true);
        $levels = $row->levels !== null ? json_decode((string) $row->levels, true) : null;

        return [
            'game_type' => $type,
            'settings' => is_array($settings) ? $settings : [],
            'levels' => is_array($levels) ? array_values($levels) : null,
            'source' => 'cloud',
            'cloud_updated_at' => $row->cloud_updated_at,
            'updated_by' => $row->updated_by_name,
            'pulled_at' => $row->pulled_at,
        ];
    }

    /** @return array{tournament: array<string, mixed>, cash: array<string, mixed>, pulled_at: ?string} */
    public function all(): array
    {
        $pulledAt = DB::table(self::TABLE)->max('pulled_at');

        return [
            'tournament' => $this->current(self::TYPE_TOURNAMENT),
            'cash' => $this->current(self::TYPE_CASH),
            'pulled_at' => $pulledAt !== null ? (string) $pulledAt : null,
        ];
    }

    /**
     * Pull the super admin's base setup from the cloud and mirror it.
     * Throws the CloudException when the cloud cannot be reached — callers
     * that only want "fresh if possible" catch it and read the mirror.
     */
    public function pull(): array
    {
        $result = $this->cloud->getJson('/api/v1/internal/game-structure');

        $this->store((array) $result['data']);

        return $this->all();
    }

    /**
     * Mirror a cloud answer ({tournament: {settings, levels, ...}|null,
     * cash: {...}|null}). A kind the cloud has no save for falls back to
     * the built-in default, so its local row goes too.
     */
    public function store(array $payload): void
    {
        $now = now();

        foreach (self::TYPES as $type) {
            $block = $payload[$type] ?? null;

            if (! is_array($block) || ! is_array($block['settings'] ?? null) || $block['settings'] === []) {
                DB::table(self::TABLE)->where('game_type', $type)->delete();

                continue;
            }

            $levels = isset($block['levels']) && is_array($block['levels']) && $block['levels'] !== []
                ? json_encode(array_values($block['levels']))
                : null;
            $updatedBy = is_array($block['updated_by'] ?? null)
                ? (string) (($block['updated_by']['display_name'] ?? null) ?: ($block['updated_by']['login'] ?? ''))
                : null;

            $attributes = [
                'settings' => json_encode($block['settings']),
                'levels' => $levels,
                'cloud_updated_at' => isset($block['updated_at']) ? mb_substr((string) $block['updated_at'], 0, 40) : null,
                'updated_by_name' => $updatedBy !== null && $updatedBy !== '' ? mb_substr($updatedBy, 0, 120) : null,
                'pulled_at' => $now,
                'updated_at' => $now,
            ];

            $exists = DB::table(self::TABLE)->where('game_type', $type)->exists();

            if ($exists) {
                DB::table(self::TABLE)->where('game_type', $type)->update($attributes);
            } else {
                DB::table(self::TABLE)->insert($attributes + ['game_type' => $type, 'created_at' => $now]);
            }
        }
    }

    /**
     * The payload TournamentService::create expects for a desk opened
     * straight from the defaults: the base setup, plus only the night's
     * own facts — which cloud session, which venue, the erase handshake.
     *
     * @param  array{game_session_id?: ?int, venue_id?: ?int, venue_name?: ?string, replace_session_id?: ?int, name?: ?string}  $context
     * @return array<string, mixed>
     */
    public function createPayload(string $type, array $context = []): array
    {
        $this->assertType($type);

        $current = $this->current($type);
        $settings = $current['settings'];
        $linked = $this->linkedSession($context['game_session_id'] ?? null);

        $venueName = $context['venue_name'] ?? $linked['venue_name'] ?? null;
        $name = trim((string) ($context['name'] ?? ''));
        if ($name === '' && ($linked['title'] ?? null) !== null) {
            // "Fri 26 Sep 2026 — Friday Deepstack": the cloud game's own
            // name, dated the way the export lists nights.
            $name = now()->format('D j M Y').' — '.$linked['title'];
        }

        $payload = [
            'game_type' => $type,
            'name' => $name !== '' ? $name : null,
            'game_session_id' => $context['game_session_id'] ?? null,
            'venue_id' => $context['venue_id'] ?? $linked['venue_id'] ?? null,
            'venue_name' => $venueName,
            'replace_session_id' => $context['replace_session_id'] ?? null,
            'seats_per_table' => (int) ($settings['seats_per_table'] ?? 8),
            'starting_stack' => (int) ($settings['starting_stack'] ?? 20000),
            'buy_in_price_cents' => (int) ($settings['buy_in_price_cents'] ?? 0),
            'jackpot_enabled' => (bool) ($settings['jackpot_enabled'] ?? false),
            'jackpot_price_cents' => (int) ($settings['jackpot_price_cents'] ?? 0),
        ];

        if ($type === self::TYPE_CASH) {
            $topups = (bool) ($settings['topups_enabled'] ?? false);
            $rebuyPrice = $topups ? (int) ($settings['rebuy_price_cents'] ?? 0) : 0;
            $rebuyChips = $topups ? max(1, (int) ($settings['rebuy_chips'] ?? 1)) : 0;
            $regClose = (int) ($settings['cash_reg_close_min'] ?? 0);
            $jackpotClose = (int) ($settings['cash_jackpot_close_min'] ?? 0);

            return $payload + [
                'rebuy_price_cents' => $rebuyPrice,
                'rebuy_chips' => $rebuyChips,
                'rebuy_tiers' => $topups ? [['price_cents' => $rebuyPrice, 'chips' => $rebuyChips]] : [],
                'max_rebuys_per_player' => $topups ? 255 : 0,
                'addon_chips' => 0,
                'addon_price_cents' => 0,
                'max_addons_per_player' => 0,
                'cash_reg_close_min' => $regClose > 0 ? $regClose : null,
                'cash_jackpot_close_min' => $jackpotClose > 0 ? $jackpotClose : null,
            ];
        }

        $rebuyTiers = $this->tiers($settings['rebuy_tiers'] ?? []);
        $addonTiers = $this->tiers($settings['addon_tiers'] ?? []);
        $levels = is_array($current['levels'] ?? null) && $current['levels'] !== []
            ? $current['levels']
            : (array) $this->builtIn(self::TYPE_TOURNAMENT)['levels'];

        return $payload + [
            'rebuy_tiers' => $rebuyTiers,
            'rebuy_price_cents' => (int) ($rebuyTiers[0]['price_cents'] ?? 0),
            'rebuy_chips' => (int) ($rebuyTiers[0]['chips'] ?? 0),
            'max_rebuys_per_player' => (int) ($settings['max_rebuys_per_player'] ?? 0),
            'addon_tiers' => $addonTiers,
            'addon_price_cents' => (int) ($addonTiers[0]['price_cents'] ?? 0),
            'addon_chips' => (int) ($addonTiers[0]['chips'] ?? 0),
            'max_addons_per_player' => (int) ($settings['max_addons_per_player'] ?? 1),
            'registration_closes_at_level' => (int) ($settings['registration_closes_at_level'] ?? 1),
            'rebuy_closes_at_level' => $this->optionalInt($settings['rebuy_closes_at_level'] ?? null),
            'addon_closes_at_level' => $this->optionalInt($settings['addon_closes_at_level'] ?? null),
            'jackpot_closes_at_level' => $this->optionalInt($settings['jackpot_closes_at_level'] ?? null),
            'settings' => ['chip_denominations' => trim((string) ($settings['chip_denominations'] ?? ''))],
            'levels' => $levels,
        ];
    }

    /** @return array{title: ?string, venue_id: ?int, venue_name: ?string}|null */
    private function linkedSession(mixed $gameSessionId): ?array
    {
        if ($gameSessionId === null || (int) $gameSessionId <= 0) {
            return null;
        }

        $row = DB::table('mirror_game_sessions')
            ->where('session_id', (int) $gameSessionId)
            ->first(['title', 'venue_id', 'venue_name']);

        if ($row === null) {
            return null;
        }

        return [
            'title' => $row->title !== null && trim((string) $row->title) !== '' ? trim((string) $row->title) : null,
            'venue_id' => $row->venue_id !== null ? (int) $row->venue_id : null,
            'venue_name' => $row->venue_name,
        ];
    }

    /** @return list<array{price_cents: int, chips: int}> */
    private function tiers(mixed $rows): array
    {
        if (! is_array($rows)) {
            return [];
        }

        $tiers = [];

        foreach ($rows as $row) {
            if (! is_array($row) || (int) ($row['chips'] ?? 0) <= 0) {
                continue;
            }

            $tiers[] = ['price_cents' => max(0, (int) ($row['price_cents'] ?? 0)), 'chips' => (int) $row['chips']];
        }

        return array_slice($tiers, 0, 4);
    }

    private function optionalInt(mixed $value): ?int
    {
        if ($value === null || $value === '' || (int) $value <= 0) {
            return null;
        }

        return (int) $value;
    }

    private function assertType(string $type): void
    {
        if (! in_array($type, self::TYPES, true)) {
            throw new \InvalidArgumentException("Unknown desk kind [{$type}].");
        }
    }
}
