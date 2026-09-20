<?php

declare(strict_types=1);

namespace App\Support;

/**
 * A cash table's stopwatch as the desk mirror holds it.
 *
 * The CLOUD is the only clock: it counts, and reports each table's elapsed
 * milliseconds and whether it is running. The mirror stores that report as
 * "elapsed at the instant we heard it" (`timer_elapsed_ms` at
 * `timer_synced_ms`, both from this machine's own clock), so between
 * reports the desk can keep counting on its own without ever comparing two
 * different machines' clocks. Relative milliseconds everywhere — the same
 * convention the tournament clock and the phones use.
 */
final class MirrorTableTimer
{
    public static function nowMs(): int
    {
        return (int) round(microtime(true) * 1000);
    }

    /** Has the director started this table's stopwatch (running or paused)? */
    public static function started(?object $row): bool
    {
        return $row !== null && ($row->timer_elapsed_ms ?? null) !== null;
    }

    public static function running(?object $row): bool
    {
        return self::started($row) && (bool) ($row->timer_running ?? false);
    }

    /** Elapsed right now, or null while the stopwatch has never been started. */
    public static function elapsedMs(?object $row, ?int $nowMs = null): ?int
    {
        if (! self::started($row)) {
            return null;
        }

        $elapsed = (int) $row->timer_elapsed_ms;

        if (self::running($row) && ($row->timer_synced_ms ?? null) !== null) {
            $elapsed += max(0, ($nowMs ?? self::nowMs()) - (int) $row->timer_synced_ms);
        }

        return max(0, $elapsed);
    }

    /**
     * The mirror columns for a cloud report.
     *
     * @param  array<string, mixed>  $table  one table of the cloud's seating payload
     * @return array{timer_running: ?bool, timer_elapsed_ms: ?int, timer_synced_ms: ?int}
     */
    public static function columnsFromCloud(array $table, ?int $nowMs = null): array
    {
        $elapsed = $table['live_elapsed_ms'] ?? null;

        if (! is_numeric($elapsed)) {
            return self::cleared();
        }

        return [
            'timer_running' => (bool) ($table['timer_running'] ?? true),
            'timer_elapsed_ms' => max(0, (int) $elapsed),
            'timer_synced_ms' => $nowMs ?? self::nowMs(),
        ];
    }

    /** @return array{timer_running: null, timer_elapsed_ms: null, timer_synced_ms: null} */
    public static function cleared(): array
    {
        return ['timer_running' => null, 'timer_elapsed_ms' => null, 'timer_synced_ms' => null];
    }

    /**
     * @return array{timer_running: bool, timer_elapsed_ms: int, timer_synced_ms: int}
     */
    public static function counting(int $elapsedMs, ?int $nowMs = null): array
    {
        return ['timer_running' => true, 'timer_elapsed_ms' => max(0, $elapsedMs), 'timer_synced_ms' => $nowMs ?? self::nowMs()];
    }

    /**
     * @return array{timer_running: bool, timer_elapsed_ms: int, timer_synced_ms: int}
     */
    public static function frozen(int $elapsedMs, ?int $nowMs = null): array
    {
        return ['timer_running' => false, 'timer_elapsed_ms' => max(0, $elapsedMs), 'timer_synced_ms' => $nowMs ?? self::nowMs()];
    }
}
