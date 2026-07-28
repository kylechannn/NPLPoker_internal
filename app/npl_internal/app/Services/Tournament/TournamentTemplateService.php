<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Tournament presets — the "start next week's game in one tap" feature.
 */
final class TournamentTemplateService
{
    /** Settings a template carries, mirroring the tournament columns. */
    private const SETTING_KEYS = [
        'starting_stack', 'rebuy_chips', 'rebuy_price_cents', 'max_rebuys_per_player',
        'addon_chips', 'addon_price_cents', 'max_addons_per_player',
        'buy_in_price_cents', 'ko_bounty_cents',
        // Cut-offs travel with the template: a template that dropped them
        // would make "start next week's game in one tap" fail validation,
        // since the registration cut-off is required to open a session.
        'registration_closes_at_level', 'addon_closes_at_level', 'rebuy_closes_at_level',
        'jackpot_enabled', 'jackpot_price_cents', 'jackpot_closes_at_level',
        'seats_per_table',
    ];

    public function __construct(private readonly TournamentClockService $clock) {}

    public function all(): array
    {
        return DB::table('tournament_templates')
            ->orderByDesc('is_default')
            ->orderByDesc('times_used')
            ->orderBy('name')
            ->get()
            ->map(fn (object $row): array => $this->present($row))
            ->all();
    }

    public function find(int $id): array
    {
        $row = DB::table('tournament_templates')->where('id', $id)->first();

        if ($row === null) {
            throw new NotFoundHttpException("Template [{$id}] not found.");
        }

        return $this->present($row);
    }

    public function default(): ?array
    {
        $row = DB::table('tournament_templates')->where('is_default', true)->first();

        return $row ? $this->present($row) : null;
    }

    /** Save a preset, optionally captured from a tournament already set up. */
    public function save(array $data): array
    {
        $levels = $data['levels'] ?? null;
        $settings = $data['settings'] ?? [];

        if (isset($data['from_tournament_id'])) {
            [$settings, $levels] = $this->captureFrom((int) $data['from_tournament_id']);
        }

        if (! is_array($levels) || $levels === []) {
            throw ValidationException::withMessages([
                'levels' => ['A template needs a blind structure.'],
            ]);
        }

        return DB::transaction(function () use ($data, $settings, $levels): array {
            $isDefault = (bool) ($data['is_default'] ?? false);

            if ($isDefault) {
                // Only one default — a second would make "fast start" ambiguous.
                DB::table('tournament_templates')->update(['is_default' => false, 'updated_at' => now()]);
            }

            $attributes = [
                'description' => $data['description'] ?? null,
                'is_default' => $isDefault,
                'settings' => json_encode($this->onlyKnownSettings($settings)),
                'levels' => json_encode(array_values($levels)),
                'updated_at' => now(),
            ];

            $existing = DB::table('tournament_templates')->where('name', $data['name'])->first();

            if ($existing !== null) {
                DB::table('tournament_templates')->where('id', $existing->id)->update($attributes);
                $id = (int) $existing->id;
            } else {
                $id = (int) DB::table('tournament_templates')->insertGetId(
                    $attributes + ['name' => $data['name'], 'created_at' => now()],
                );
            }

            return $this->find($id);
        }, 3);
    }

    public function delete(int $id): void
    {
        $this->find($id);
        DB::table('tournament_templates')->where('id', $id)->delete();
    }

    /**
     * Turn a template into the payload TournamentService::create expects.
     * Anything passed explicitly by the caller still wins, so a preset is a
     * starting point rather than a straitjacket.
     */
    public function toCreatePayload(array $template, array $overrides = []): array
    {
        DB::table('tournament_templates')->where('id', $template['id'])->update([
            'times_used' => DB::raw('times_used + 1'),
            'last_used_at' => now(),
            'updated_at' => now(),
        ]);

        return array_merge(
            $template['settings'],
            ['levels' => $template['levels']],
            array_filter($overrides, fn ($value): bool => $value !== null && $value !== ''),
        );
    }

    /** @return array{0: array, 1: array} settings, levels */
    private function captureFrom(int $tournamentId): array
    {
        $session = $this->clock->session($tournamentId);

        $settings = [];
        foreach (self::SETTING_KEYS as $key) {
            $settings[$key] = $session->{$key};
        }

        $levels = array_map(fn (object $level): array => [
            'level_no' => (int) $level->level_no,
            'type' => $level->type,
            'small_blind' => (int) $level->small_blind,
            'big_blind' => (int) $level->big_blind,
            'ante' => (int) $level->ante,
            'bb_ante' => (int) $level->bb_ante,
            'duration_min' => (int) $level->duration_min,
            'note' => $level->note,
        ], $this->clock->levels($tournamentId));

        return [$settings, $levels];
    }

    private function onlyKnownSettings(array $settings): array
    {
        $clean = [];

        foreach (self::SETTING_KEYS as $key) {
            if (array_key_exists($key, $settings) && $settings[$key] !== null) {
                $clean[$key] = (int) $settings[$key];
            }
        }

        return $clean;
    }

    private function present(object $row): array
    {
        return [
            'id' => (int) $row->id,
            'name' => $row->name,
            'description' => $row->description,
            'is_default' => (bool) $row->is_default,
            'settings' => json_decode((string) $row->settings, true) ?: [],
            'levels' => json_decode((string) $row->levels, true) ?: [],
            'level_count' => count(json_decode((string) $row->levels, true) ?: []),
            'times_used' => (int) $row->times_used,
            'last_used_at' => $row->last_used_at,
        ];
    }
}
