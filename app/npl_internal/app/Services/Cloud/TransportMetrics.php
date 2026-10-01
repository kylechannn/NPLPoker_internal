<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use Carbon\Carbon;
use Illuminate\Database\Connection;
use Illuminate\Support\Facades\DB;

/** Fixed labels and minute totals only. No request content or identifiers. */
final class TransportMetrics
{
    public const FAMILIES = ['session_batch', 'session_catalogue', 'seating', 'cash_moves', 'cash_ack', 'desk_pulse', 'clock_write', 'outbox_write', 'other'];

    public const BOUNDS = [100, 300, 1000, 3000, 10000];

    public static function family(string $path): string
    {
        return match (true) {
            $path === '/api/v1/internal/sessions/snapshots' => 'session_batch',
            $path === '/api/v1/game-sessions' => 'session_catalogue',
            preg_match('#^/api/v1/internal/sessions/\d+/seating$#', $path) === 1 => 'seating',
            preg_match('#^/api/v1/internal/desk-sessions/\d+/cash-table-moves/\d+/ack$#', $path) === 1 => 'cash_ack',
            preg_match('#^/api/v1/internal/desk-sessions/\d+/cash-table-moves$#', $path) === 1 => 'cash_moves',
            $path === '/api/v1/internal/desk-pulse' => 'desk_pulse',
            $path === '/api/v1/internal/tournament/state' => 'clock_write',
            $path === '/api/v1/internal/outbox' => 'outbox_write',
            default => 'other',
        };
    }

    private function connection(): Connection
    {
        // The tests' cache SQLite is in-memory, so reuse its migrated connection.
        return DB::connection(config('database.connections.cache.database') === ':memory:' ? 'cache' : 'transport');
    }

    public function record(string $family, int $status, int $durationMs, int $bytes, int $attempts, bool $failed): void
    {
        try {
            if (! in_array($family, self::FAMILIES, true)) {
                $family = 'other';
            }
            $minute = intdiv(now()->timestamp, 60);
            $durationMs = max(0, min(600000, $durationMs));
            $values = ['minute' => $minute, 'family' => $family, 'requests' => 1,
                'attempts' => max(0, min(100, $attempts)), 'not_modified' => (int) ($status === 304),
                'errors' => (int) $failed, 'skipped' => (int) ($attempts === 0),
                'response_body_bytes' => max(0, min(100000000, $bytes)), 'duration_sum_ms' => $durationMs, 'duration_max_ms' => $durationMs];
            $bucket = 'inf';
            foreach (self::BOUNDS as $bound) {
                if ($durationMs <= $bound) {
                    $bucket = (string) $bound;
                    break;
                }
            }
            foreach ([...self::BOUNDS, 'inf'] as $bound) {
                $values['bucket_'.$bound] = (int) ((string) $bound === $bucket);
            }
            $db = $this->connection();
            $db->table('transport_metric_buckets')->where('minute', '<', $minute - 59)->orWhere('minute', '>', $minute)->delete();
            $updates = [];
            foreach (array_diff(array_keys($values), ['minute', 'family']) as $column) {
                $updates[$column] = DB::raw($column === 'duration_max_ms'
                    ? 'MAX(transport_metric_buckets.duration_max_ms, '.(int) $values[$column].')'
                    : 'transport_metric_buckets.'.$column.' + '.(int) $values[$column]);
            }
            $db->table('transport_metric_buckets')->upsert($values, ['minute', 'family'], $updates);
        } catch (\Throwable) {
            // Missing migration, busy disk, or diagnostic storage failure must
            // never change an HTTP result, a financial write, or a Cash ACK.
        }
    }

    public function snapshot(): array
    {
        $result = ['schema_version' => 1, 'window_minutes' => 60, 'generated_at' => now()->toIso8601String(),
            'available' => false, 'histogram_bounds_ms' => [...self::BOUNDS, 'inf'], 'families' => [], 'backlog' => null];
        try {
            $rows = $this->connection()->table('transport_metric_buckets')
                ->where('minute', '>=', intdiv(now()->timestamp, 60) - 59)->where('minute', '<=', intdiv(now()->timestamp, 60))
                ->whereIn('family', self::FAMILIES)->get();
            foreach ($rows->groupBy('family') as $family => $buckets) {
                $item = ['family' => $family];
                foreach (['requests', 'attempts', 'not_modified', 'errors', 'skipped', 'response_body_bytes', 'duration_sum_ms'] as $column) {
                    $item[$column] = (int) $buckets->sum($column);
                }
                $item['duration_max_ms'] = (int) $buckets->max('duration_max_ms');
                $item['duration_buckets'] = array_map(fn ($bound): int => (int) $buckets->sum('bucket_'.$bound), [...self::BOUNDS, 'inf']);
                $result['families'][] = $item;
            }
            $result['available'] = true;
        } catch (\Throwable) {
        }
        try {
            $pending = DB::table('cash_table_moves')->whereIn('status', ['applied_pending', 'failed_pending']);
            $oldest = (clone $pending)->min('created_at');
            $result['backlog'] = [
                'cash_ack_pending' => (clone $pending)->count(),
                'cash_ack_oldest_age_seconds' => $oldest ? max(0, now()->timestamp - Carbon::parse($oldest)->timestamp) : null,
                'outbox_pending' => DB::table('sync_outbox')->whereIn('status', ['pending', 'sending'])->count(),
                'outbox_dead' => DB::table('sync_outbox')->where('status', 'dead')->count(),
                'cloud_pending' => DB::table('cloud_call_queue')->whereIn('status', ['pending', 'sending'])->count(),
                'cloud_dead' => DB::table('cloud_call_queue')->where('status', 'dead')->count(),
            ];
        } catch (\Throwable) {
        }

        return $result;
    }
}
