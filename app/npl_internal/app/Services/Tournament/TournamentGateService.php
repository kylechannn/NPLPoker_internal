<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use Illuminate\Support\Facades\DB;

/**
 * The single authority on what the desk (and the public app) may still do.
 *
 * Registration, rebuys, add-ons and the jackpot each close at a level index.
 * Every surface asks this one service rather than re-deriving the rule:
 * the scan endpoint, the action endpoint, the seating map and the cloud
 * broadcast all agree by construction.
 *
 * Cut-offs are indexes into the level ladder, but players want a countdown,
 * so each gate also reports how many milliseconds of *play* remain before it
 * shuts. That figure is computed from the live clock, which means it stops
 * moving whenever the desk pauses — the same thing the room experiences.
 */
final class TournamentGateService
{
    public const REGISTRATION = 'registration';

    public const REBUY = 'rebuy';

    public const ADDON = 'addon';

    public const JACKPOT = 'jackpot';

    public function __construct(private readonly TournamentClockService $clock) {}

    /**
     * Every gate's state for one tournament.
     *
     * @return array<string, array{open:bool,closes_at_level:?int,closes_in_ms:?int,reason:?string}>
     */
    public function gates(int $sessionId, ?object $session = null, ?array $state = null): array
    {
        $session ??= $this->clock->session($sessionId);
        $state ??= $this->clock->state($sessionId);
        $levels = $this->clock->levels($sessionId);

        $finished = $session->status === TournamentClockService::STATUS_FINISHED;

        // Registration is the mandatory one; the rest fall back to it so a
        // desk that only sets the required field still gets sane behaviour.
        $registrationLevel = $session->registration_closes_at_level !== null
            ? (int) $session->registration_closes_at_level
            : null;

        return [
            self::REGISTRATION => $this->gate($registrationLevel, $state, $levels, $finished, 'Registration'),
            self::REBUY => $this->gate(
                $session->rebuy_closes_at_level !== null ? (int) $session->rebuy_closes_at_level : $registrationLevel,
                $state,
                $levels,
                $finished,
                'Rebuys',
            ),
            self::ADDON => $this->gate(
                $session->addon_closes_at_level !== null ? (int) $session->addon_closes_at_level : null,
                $state,
                $levels,
                $finished,
                'Add-ons',
            ),
            self::JACKPOT => $this->gate(
                $session->jackpot_closes_at_level !== null ? (int) $session->jackpot_closes_at_level : $registrationLevel,
                $state,
                $levels,
                $finished,
                'Jackpot entry',
            ),
        ];
    }

    /**
     * @param  int|null  $closesAtLevel  null = never closes on its own
     * @return array{open:bool,closes_at_level:?int,closes_in_ms:?int,reason:?string}
     */
    private function gate(?int $closesAtLevel, array $state, array $levels, bool $finished, string $label): array
    {
        if ($finished) {
            return [
                'open' => false,
                'closes_at_level' => $closesAtLevel,
                'closes_in_ms' => 0,
                'reason' => $label.' closed — the tournament has finished.',
            ];
        }

        if ($closesAtLevel === null) {
            return ['open' => true, 'closes_at_level' => null, 'closes_in_ms' => null, 'reason' => null];
        }

        $index = (int) $state['level_index'];
        $open = $index < $closesAtLevel;

        return [
            'open' => $open,
            'closes_at_level' => $closesAtLevel,
            'closes_in_ms' => $open
                ? $this->msUntilLevel($closesAtLevel, $index, (int) $state['remaining_ms'], $levels)
                : 0,
            'reason' => $open
                ? null
                : sprintf('%s closed at level %d.', $label, $closesAtLevel),
        ];
    }

    /**
     * Play time between now and the start of `$targetIndex`: what is left of
     * the current level, plus every level in between.
     *
     * Breaks are included because they are wall-clock time the room actually
     * sits through — a countdown that skipped them would run out early.
     */
    private function msUntilLevel(int $targetIndex, int $currentIndex, int $remainingMs, array $levels): int
    {
        $total = max(0, $remainingMs);

        for ($i = $currentIndex + 1; $i < $targetIndex; $i++) {
            if (! isset($levels[$i])) {
                break;
            }

            $total += ((int) $levels[$i]->duration_min) * 60_000;
        }

        return $total;
    }

    /**
     * Whether a specific player may take a specific action right now, and why
     * not if they may not.
     *
     * The distinction the desk cares about: once registration closes, a NEW
     * player cannot buy in, but a player already in the field can still rebuy
     * and add on until those gates close in their own right.
     *
     * @return array{allowed:bool,reason:?string}
     */
    public function check(int $sessionId, string $action, bool $playerIsRegistered, ?object $session = null, ?array $state = null): array
    {
        $gates = $this->gates($sessionId, $session, $state);

        return match ($action) {
            'buy_in' => $playerIsRegistered
                ? ['allowed' => false, 'reason' => 'This player has already bought in.']
                : $this->fromGate($gates[self::REGISTRATION], 'Registration has closed — no new entries.'),

            'rebuy' => ! $playerIsRegistered
                ? ['allowed' => false, 'reason' => 'This player has not bought in yet.']
                : $this->fromGate($gates[self::REBUY], 'Rebuys have closed.'),

            'addon' => ! $playerIsRegistered
                ? ['allowed' => false, 'reason' => 'This player has not bought in yet.']
                : $this->fromGate($gates[self::ADDON], 'Add-ons have closed.'),

            'jackpot' => ! $playerIsRegistered
                ? ['allowed' => false, 'reason' => 'Buy in before joining the jackpot.']
                : $this->fromGate($gates[self::JACKPOT], 'Jackpot entry has closed.'),

            default => ['allowed' => true, 'reason' => null],
        };
    }

    /** @param  array{open:bool,reason:?string}  $gate */
    private function fromGate(array $gate, string $fallback): array
    {
        return $gate['open']
            ? ['allowed' => true, 'reason' => null]
            : ['allowed' => false, 'reason' => $gate['reason'] ?? $fallback];
    }

    /**
     * The level index a cut-off must not exceed — used to validate the preset
     * screen, so a desk cannot set "registration closes at level 40" on an
     * 18-level structure and silently get "never".
     */
    public function levelCount(int $sessionId): int
    {
        return DB::table('tournament_levels')
            ->where('tournament_session_id', $sessionId)
            ->count();
    }
}
