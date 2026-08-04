<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

/**
 * Server-authoritative tournament clock.
 *
 * EdgeHost ran its Sichuan clock entirely in one browser window: the
 * remaining time was a JS deadline, pause simply discarded it, and nothing
 * was ever persisted. Two timer windows drifted apart, a reload restarted
 * the tournament at level 1, and no other screen could ever know the state.
 *
 * Here the clock is arithmetic over stored timestamps:
 *
 *     elapsed   = (paused_at ?? now) - level_started_at - pause_accum_ms
 *     remaining = level_duration - elapsed
 *
 * Every consumer — the desk, the big screen, a player's phone — derives the
 * same answer, and clients only need to re-sync occasionally because they
 * can tick locally between updates.
 *
 * Level advance is LAZY: whenever the clock is read while running past its
 * deadline, it rolls forward (and persists) as many levels as actually
 * elapsed. No cron, no background worker, and a machine that slept through
 * three levels catches up correctly on the next read.
 */
final class TournamentClockService
{
    public const STATUS_DRAFT = 'draft';

    public const STATUS_RUNNING = 'running';

    public const STATUS_PAUSED = 'paused';

    public const STATUS_FINISHED = 'finished';

    /** A sensible NPL default so a session is playable without setup. */
    public const DEFAULT_STRUCTURE = [
        ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'ante' => 0, 'bb_ante' => 200, 'duration_min' => 20],
        ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'ante' => 0, 'bb_ante' => 400, 'duration_min' => 20],
        ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'ante' => 0, 'bb_ante' => 600, 'duration_min' => 20],
        ['level_no' => 4, 'type' => 'blind', 'small_blind' => 500, 'big_blind' => 1000, 'ante' => 0, 'bb_ante' => 1000, 'duration_min' => 20],
        ['level_no' => 0, 'type' => 'break', 'small_blind' => 0, 'big_blind' => 0, 'ante' => 0, 'bb_ante' => 0, 'duration_min' => 15, 'note' => 'Break — registration closes'],
        ['level_no' => 5, 'type' => 'blind', 'small_blind' => 800, 'big_blind' => 1600, 'ante' => 0, 'bb_ante' => 1600, 'duration_min' => 20],
        ['level_no' => 6, 'type' => 'blind', 'small_blind' => 1200, 'big_blind' => 2400, 'ante' => 0, 'bb_ante' => 2400, 'duration_min' => 20],
        ['level_no' => 7, 'type' => 'blind', 'small_blind' => 2000, 'big_blind' => 4000, 'ante' => 0, 'bb_ante' => 4000, 'duration_min' => 20],
        ['level_no' => 8, 'type' => 'blind', 'small_blind' => 3000, 'big_blind' => 6000, 'ante' => 0, 'bb_ante' => 6000, 'duration_min' => 20],
    ];

    /** The authoritative state every display renders from. */
    public function state(int $sessionId): array
    {
        $session = $this->session($sessionId);
        $levels = $this->levels($sessionId);

        // Roll forward first, so a stale read never reports an expired level.
        if ($session->status === self::STATUS_RUNNING) {
            $session = $this->advanceIfElapsed($session, $levels);
        }

        $index = (int) $session->current_level_index;
        $current = $levels[$index] ?? null;
        $next = $levels[$index + 1] ?? null;
        $remainingMs = $this->remainingMs($session, $current);

        return [
            'session_id' => (int) $session->id,
            'uuid' => $session->uuid,
            'name' => $session->name,
            'venue_name' => $session->venue_name,
            'status' => $session->status,
            'running' => $session->status === self::STATUS_RUNNING,

            'level_index' => $index,
            'level_count' => count($levels),
            'current_level' => $current ? $this->presentLevel($current, $index) : null,
            'next_level' => $next ? $this->presentLevel($next, $index + 1) : null,

            'remaining_ms' => $remainingMs,
            'level_duration_ms' => $current ? ((int) $current->duration_min) * 60_000 : 0,
            // Always emitted with an offset: these cross a process boundary
            // to the cloud and to browsers, and a naive string would be read
            // in whatever timezone the reader happens to use.
            'level_started_at' => $this->iso($session->level_started_at),
            'paused_at' => $this->iso($session->paused_at),
            'pause_accum_ms' => (int) $session->pause_accum_ms,

            // Clients tick locally between syncs; this lets them correct for
            // clock skew instead of trusting the device clock.
            'server_time' => now()->toIso8601String(),
            'server_time_ms' => (int) (microtime(true) * 1000),

            'registration_open' => $this->registrationOpen($session, $index, $levels),
            // What the room actually asks the floor: "when is the break?"
            'next_break' => $this->nextBreak($levels, $index, $remainingMs, $session),
            'started_at' => $this->iso($session->started_at),
            'finished_at' => $this->iso($session->finished_at),
        ];
    }

    /**
     * The next break on the ladder, with wall-clock time until it starts:
     * what's left of the current level plus every full level in between
     * (breaks are levels, so the sum is exact). Null when none remains.
     */
    private function nextBreak(array $levels, int $index, int $remainingMs, object $session): ?array
    {
        if ($session->status === self::STATUS_FINISHED) {
            return null;
        }

        $current = $levels[$index] ?? null;

        if ($current !== null && $current->type === 'break') {
            return [
                'index' => $index,
                'label' => $current->note ?: 'Break',
                'in_ms' => 0,
                'on_break' => true,
            ];
        }

        // Before the first start the clock has no anchor — count the whole
        // current level rather than a zero remainder.
        $accumMs = $session->status === self::STATUS_DRAFT
            ? ($current !== null ? ((int) $current->duration_min) * 60_000 : 0)
            : $remainingMs;

        for ($i = $index + 1, $n = count($levels); $i < $n; $i++) {
            if ($levels[$i]->type === 'break') {
                return [
                    'index' => $i,
                    'label' => $levels[$i]->note ?: 'Break',
                    'in_ms' => $accumMs,
                    'on_break' => false,
                ];
            }

            $accumMs += ((int) $levels[$i]->duration_min) * 60_000;
        }

        return null;
    }

    public function start(int $sessionId): array
    {
        $session = $this->session($sessionId);

        $this->assertStatus($session, [self::STATUS_DRAFT], 'Only a draft tournament can be started.');

        if ($this->levels($sessionId) === []) {
            throw ValidationException::withMessages(['levels' => ['Add a blind structure before starting.']]);
        }

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'status' => self::STATUS_RUNNING,
            'current_level_index' => 0,
            'level_started_at' => now(),
            'paused_at' => null,
            'pause_accum_ms' => 0,
            'started_at' => now(),
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    public function pause(int $sessionId): array
    {
        $session = $this->session($sessionId);
        $this->assertStatus($session, [self::STATUS_RUNNING], 'Only a running tournament can be paused.');

        // Freeze the clock by stamping when it stopped; elapsed maths uses
        // paused_at in place of now() from here.
        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'status' => self::STATUS_PAUSED,
            'paused_at' => now(),
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    public function resume(int $sessionId): array
    {
        $session = $this->session($sessionId);
        $this->assertStatus($session, [self::STATUS_PAUSED], 'Only a paused tournament can be resumed.');

        // Fold the paused span into the accumulator so the level keeps the
        // time it had left, rather than restarting it.
        $pausedMs = $session->paused_at
            ? max(0, (int) (Carbon::parse($session->paused_at)->diffInMilliseconds(now())))
            : 0;

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'status' => self::STATUS_RUNNING,
            'paused_at' => null,
            'pause_accum_ms' => (int) $session->pause_accum_ms + $pausedMs,
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    /** Operator override — jump to a level and restart its full duration. */
    public function goToLevel(int $sessionId, int $index): array
    {
        $session = $this->session($sessionId);
        $this->assertStatus($session, [self::STATUS_RUNNING, self::STATUS_PAUSED], 'The tournament is not live.');

        $levels = $this->levels($sessionId);

        if ($index < 0 || $index >= count($levels)) {
            throw ValidationException::withMessages(['level_index' => ['That level does not exist.']]);
        }

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'current_level_index' => $index,
            'level_started_at' => now(),
            'pause_accum_ms' => 0,
            // Keep a paused tournament paused; jumping should not start play.
            'paused_at' => $session->status === self::STATUS_PAUSED ? now() : null,
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    public function nextLevel(int $sessionId): array
    {
        return $this->goToLevel($sessionId, (int) $this->session($sessionId)->current_level_index + 1);
    }

    public function previousLevel(int $sessionId): array
    {
        return $this->goToLevel($sessionId, max(0, (int) $this->session($sessionId)->current_level_index - 1));
    }

    /** Add or remove time from the running level without changing level. */
    public function adjustTime(int $sessionId, int $deltaSeconds): array
    {
        $session = $this->session($sessionId);
        $this->assertStatus($session, [self::STATUS_RUNNING, self::STATUS_PAUSED], 'The tournament is not live.');

        // Shifting the accumulator moves the deadline: more accumulated pause
        // means more time left.
        $accum = (int) $session->pause_accum_ms + ($deltaSeconds * 1000);

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'pause_accum_ms' => max(0, $accum),
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    public function finish(int $sessionId): array
    {
        $session = $this->session($sessionId);
        $this->assertStatus(
            $session,
            [self::STATUS_RUNNING, self::STATUS_PAUSED, self::STATUS_DRAFT],
            'This tournament is already finished.',
        );

        DB::table('tournament_sessions')->where('id', $sessionId)->update([
            'status' => self::STATUS_FINISHED,
            'paused_at' => null,
            'finished_at' => now(),
            'updated_at' => now(),
        ]);

        return $this->state($sessionId);
    }

    // ---- internals -------------------------------------------------------

    /**
     * Roll the level forward for however long the clock actually ran past its
     * deadline — handles a machine that slept through several levels.
     */
    private function advanceIfElapsed(object $session, array $levels): object
    {
        $index = (int) $session->current_level_index;
        $accum = (int) $session->pause_accum_ms;
        $startedAt = $session->level_started_at ? Carbon::parse($session->level_started_at) : null;

        if ($startedAt === null) {
            return $session;
        }

        // Same signing as remainingMs(): negative means time was added.
        $elapsedMs = (int) $startedAt->diffInMilliseconds(now()) - $accum;
        $advanced = false;

        while (isset($levels[$index])) {
            $durationMs = ((int) $levels[$index]->duration_min) * 60_000;

            if ($elapsedMs < $durationMs) {
                break;
            }

            if (! isset($levels[$index + 1])) {
                // Past the last level: hold on it rather than running off the end.
                break;
            }

            $elapsedMs -= $durationMs;
            $index++;
            $advanced = true;
        }

        if (! $advanced) {
            return $session;
        }

        // Re-base so the new level started exactly when the previous expired.
        $newStartedAt = now()->subMilliseconds($elapsedMs);

        DB::table('tournament_sessions')->where('id', $session->id)->update([
            'current_level_index' => $index,
            'level_started_at' => $newStartedAt,
            'pause_accum_ms' => 0,
            'updated_at' => now(),
        ]);

        return $this->session((int) $session->id);
    }

    private function remainingMs(object $session, ?object $level): int
    {
        if ($level === null || $session->level_started_at === null) {
            return 0;
        }

        if ($session->status === self::STATUS_FINISHED) {
            return 0;
        }

        $durationMs = ((int) $level->duration_min) * 60_000;
        $reference = $session->paused_at ? Carbon::parse($session->paused_at) : now();

        // Deliberately NOT clamped at zero: the accumulator also carries
        // operator-added time, so a negative elapsed means the level has more
        // than its nominal duration left.
        $elapsed = (int) Carbon::parse($session->level_started_at)->diffInMilliseconds($reference)
            - (int) $session->pause_accum_ms;

        return max(0, $durationMs - $elapsed);
    }

    /**
     * Registration/rebuys close once the configured level is reached — the
     * poker equivalent of EdgeHost's "revive closes after the first break".
     */
    private function registrationOpen(object $session, int $index, array $levels): bool
    {
        if ($session->status === self::STATUS_FINISHED) {
            return false;
        }

        $closesAt = $session->registration_closes_at_level;

        if ($closesAt === null) {
            return true;
        }

        return $index < (int) $closesAt;
    }

    private function presentLevel(object $level, int $index): array
    {
        return [
            'index' => $index,
            'level_no' => (int) $level->level_no,
            'type' => $level->type,
            'is_break' => $level->type === 'break',
            'small_blind' => (int) $level->small_blind,
            'big_blind' => (int) $level->big_blind,
            'ante' => (int) $level->ante,
            'bb_ante' => (int) $level->bb_ante,
            'duration_min' => (int) $level->duration_min,
            'note' => $level->note,
            // Pre-formatted so every surface renders blinds identically.
            'label' => $level->type === 'break'
                ? ($level->note ?: 'Break')
                : sprintf('%s / %s', number_format((int) $level->small_blind), number_format((int) $level->big_blind)),
        ];
    }

    /** @return list<object> ordered by sort_order */
    public function levels(int $sessionId): array
    {
        return DB::table('tournament_levels')
            ->where('tournament_session_id', $sessionId)
            ->orderBy('sort_order')
            ->get()
            ->all();
    }

    public function session(int $sessionId): object
    {
        $session = DB::table('tournament_sessions')->where('id', $sessionId)->first();

        if ($session === null) {
            throw new NotFoundHttpException("Tournament [{$sessionId}] not found.");
        }

        return $session;
    }

    /** Naive DB strings become unambiguous instants for anyone downstream. */
    private function iso(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return Carbon::parse($value)->toIso8601String();
    }

    private function assertStatus(object $session, array $allowed, string $message): void
    {
        if (! in_array($session->status, $allowed, true)) {
            throw ValidationException::withMessages(['status' => [$message]]);
        }
    }
}
