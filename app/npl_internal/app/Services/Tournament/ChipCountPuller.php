<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\LicenseKeyProvider;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Pulls the live chip counts admin phones recorded in the cloud for this
 * desk's session, into the local live_chip_counts cache the seating map
 * reads. The cloud is the only writer: a successful pull REPLACES the
 * local rows (so clearing a mis-count on a phone clears the desk too),
 * while a failed pull keeps whatever the desk already knows — flaky
 * internet must never blank the rail mid-game.
 */
final class ChipCountPuller
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly TournamentBroadcaster $broadcaster,
        private readonly LicenseKeyProvider $license,
    ) {}

    /** @return array{counted: int, total: int|null} */
    public function sync(int $sessionId): array
    {
        if (! $this->license->isActivated()) {
            return $this->localSummary($sessionId);
        }

        try {
            $response = $this->cloud->getJson('/api/v1/internal/chip-counts', [
                'uid' => $this->broadcaster->uid($sessionId),
            ]);
            $counts = $response['data']['counts'] ?? [];
        } catch (Throwable $e) {
            Log::info('chip count pull skipped', ['session' => $sessionId, 'error' => $e->getMessage()]);

            return $this->localSummary($sessionId);
        }

        DB::transaction(function () use ($sessionId, $counts): void {
            DB::table('live_chip_counts')->where('tournament_session_id', $sessionId)->delete();

            $rows = [];
            foreach ($counts as $count) {
                $nplId = strtoupper(trim((string) ($count['npl_id'] ?? '')));
                $chips = $count['chips'] ?? null;

                if ($nplId === '' || ! is_numeric($chips)) {
                    continue;
                }

                $rows[] = [
                    'tournament_session_id' => $sessionId,
                    'player_npl_id' => $nplId,
                    'chips' => max(0, (int) $chips),
                    'recorded_by' => isset($count['recorded_by']) ? (string) $count['recorded_by'] : null,
                    'counted_at' => isset($count['updated_at']) ? (string) $count['updated_at'] : null,
                    'created_at' => now(),
                    'updated_at' => now(),
                ];
            }

            if ($rows !== []) {
                DB::table('live_chip_counts')->insert($rows);
            }
        });

        return $this->localSummary($sessionId);
    }

    /** @return array{counted: int, total: int|null} */
    private function localSummary(int $sessionId): array
    {
        $summary = DB::table('live_chip_counts')
            ->where('tournament_session_id', $sessionId)
            ->selectRaw('COUNT(*) as counted, COALESCE(SUM(chips), 0) as total')
            ->first();

        $counted = (int) ($summary->counted ?? 0);

        return [
            'counted' => $counted,
            'total' => $counted > 0 ? (int) $summary->total : null,
        ];
    }
}
