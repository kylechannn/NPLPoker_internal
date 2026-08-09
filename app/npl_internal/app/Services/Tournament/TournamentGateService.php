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

        // Cash games have a timer, not a ladder: registration and jackpot
        // cut off a set number of MINUTES after Start game. Rebuys stay
        // open until the game finishes; add-ons don't exist at a cash desk.
        if (($session->game_type ?? 'tournament') === 'cash') {
            return [
                self::REGISTRATION => $this->timeGate(
                    $session->cash_reg_close_min !== null ? (int) $session->cash_reg_close_min : null,
                    $state,
                    $finished,
                    'Registration',
                ),
                self::REBUY => $this->timeGate(null, $state, $finished, 'Rebuys'),
                self::ADDON => $this->timeGate(null, $state, $finished, 'Add-ons'),
                self::JACKPOT => $this->timeGate(
                    $session->cash_jackpot_close_min !== null ? (int) $session->cash_jackpot_close_min : null,
                    $state,
                    $finished,
                    'Jackpot entry',
                ),
            ];
        }

        // Every cut-off stands alone — the desk fills each one itself, and a
        // blank means that action stays open until the tournament finishes.
        // (Rebuy/jackpot used to inherit the registration cut-off; venues
        // run them independently, so that surprise is gone.)
        $registrationLevel = $session->registration_closes_at_level !== null
            ? (int) $session->registration_closes_at_level
            : null;

        return [
            self::REGISTRATION => $this->gate($registrationLevel, $state, $levels, $finished, 'Registration'),
            self::REBUY => $this->gate(
                $session->rebuy_closes_at_level !== null ? (int) $session->rebuy_closes_at_level : null,
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
                $session->jackpot_closes_at_level !== null ? (int) $session->jackpot_closes_at_level : null,
                $state,
                $levels,
                $finished,
                'Jackpot entry',
            ),
        ];
    }

    /**
     * A cash-game gate: closes N minutes after Start game (measured in play
     * time — the single placeholder level's elapsed, so pausing the timer
     * pauses the countdown too). Null = open until the game finishes.
     *
     * @return array{open:bool,closes_at_level:?int,closes_in_ms:?int,reason:?string}
     */
    private function timeGate(?int $closesAfterMin, array $state, bool $finished, string $label): array
    {
        if ($finished) {
            return [
                'open' => false,
                'closes_at_level' => null,
                'closes_in_ms' => 0,
                'reason' => $label.' closed — the game has finished.',
            ];
        }

        if ($closesAfterMin === null) {
            return ['open' => true, 'closes_at_level' => null, 'closes_in_ms' => null, 'reason' => null];
        }

        // Elapsed play = the placeholder level's duration minus what remains.
        // Before Start game the level has never begun (remaining reads 0),
        // so an unstarted clock means nothing has elapsed at all.
        $elapsedMs = ($state['level_started_at'] ?? null) === null
            ? 0
            : max(0, (int) ($state['level_duration_ms'] ?? 0) - (int) ($state['remaining_ms'] ?? 0));
        $closeMs = $closesAfterMin * 60_000;
        $open = $elapsedMs < $closeMs;

        return [
            'open' => $open,
            'closes_at_level' => null,
            'closes_in_ms' => $open ? $closeMs - $elapsedMs : 0,
            'reason' => $open
                ? null
                : sprintf('%s closed %d minutes after the start.', $label, $closesAfterMin),
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
        $session ??= $this->clock->session($sessionId);
        $gates = $this->gates($sessionId, $session, $state);

        // The jackpot is a door you walk through ON the first buy-in — tick
        // it together with the buy-in, or never. On cash desks and
        // tournaments alike, a player already in the game can no longer
        // join; the one legitimate pair (buy-in + jackpot ticked in the same
        // submit) is let through by TournamentDeskService::apply's
        // first_buy_in pass.
        if ($action === 'jackpot') {
            return $playerIsRegistered
                ? ['allowed' => false, 'reason' => 'Jackpot is only available with the first buy-in.']
                : $this->fromGate($gates[self::JACKPOT], 'Jackpot entry has closed.');
        }

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
