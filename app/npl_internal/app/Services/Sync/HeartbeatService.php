<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudClient;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Reports this install's own state back to the cloud after a run.
 *
 * EdgeHost kept its sync state in `os.Setenv` — invisible to the UI, to
 * Laravel and to a support engineer, and lost on restart. Here the venue
 * machine tells the cloud when it last pulled and pushed and what it now
 * holds, which lands on the licence activation and shows up in the admin
 * License tab.
 */
final class HeartbeatService
{
    public function __construct(private readonly CloudClient $cloud) {}

    /** Never throws: a failed heartbeat must not fail an otherwise good run. */
    public function report(string $status = 'succeeded'): bool
    {
        try {
            $lastRun = DB::table('sync_runs')->orderByDesc('id')->first();
            $lastSent = DB::table('sync_outbox')->where('status', 'sent')->orderByDesc('sent_at')->value('sent_at');

            $this->cloud->postJson('/api/v1/internal/heartbeat', array_filter([
                'app_version' => (string) config('app.version', 'dev'),
                'os' => PHP_OS_FAMILY.' php'.PHP_MAJOR_VERSION.'.'.PHP_MINOR_VERSION,
                'device_label' => gethostname() ?: null,
                'last_pull_at' => $lastRun?->finished_at,
                'last_push_at' => $lastSent,
                'last_sync_status' => $status,
                'stats' => $this->stats(),
            ], fn ($value): bool => $value !== null));

            return true;
        } catch (Throwable $e) {
            Log::info('heartbeat skipped', ['error' => $e->getMessage()]);

            return false;
        }
    }

    /** What this venue machine currently holds. */
    private function stats(): array
    {
        $counts = [];

        foreach ([
            'venues' => 'mirror_venues',
            'game_sessions' => 'mirror_game_sessions',
            'seats' => 'mirror_session_tables',
            'players' => 'mirror_players',
            'game_entities' => 'mirror_game_entities',
            'relationships' => 'mirror_player_relationships',
        ] as $label => $table) {
            $counts[$label] = DB::table($table)->count();
        }

        $counts['avatars'] = DB::table('media_cache')->where('status', 'ok')->count();
        $counts['outbox_pending'] = DB::table('sync_outbox')->where('status', 'pending')->count();
        $counts['outbox_dead'] = DB::table('sync_outbox')->where('status', 'dead')->count();

        return $counts;
    }
}
