<?php

declare(strict_types=1);

namespace App\Services\Players;

use App\Services\Cloud\CloudClient;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * One scan input, two identifier spaces: NL####### member card numbers
 * (assigned) and NPL IDs (chosen). The namespaces are disjoint by cloud
 * contract, so a single resolution answers either without ambiguity.
 *
 * The mirror answers first because it is instant; a miss goes straight to
 * the cloud — the roster authority — so a player who registered a minute
 * ago still scans clean, and the hit is cached back into the mirror.
 * Every desk surface that scans a player must resolve through here.
 */
final class PlayerResolver
{
    public function __construct(private readonly CloudClient $cloud) {}

    public function resolve(string $rawId): ?object
    {
        $id = Str::upper(trim(preg_replace('/\s+/', '', $rawId) ?? ''));

        if ($id === '') {
            return null;
        }

        // Case-insensitive: input is uppercased, stored NPL IDs may be
        // mixed-case, and the local SQLite compares case-sensitively.
        $player = DB::table('mirror_players')
            ->where(fn ($query) => $query
                ->whereRaw('UPPER(npl_id) = ?', [$id])
                ->orWhereRaw('UPPER(public_player_code) = ?', [$id]))
            ->first();

        if ($player !== null) {
            return $player;
        }

        try {
            $result = $this->cloud->getJson('/api/v1/internal/players/resolve', ['id' => $id]);
        } catch (Throwable) {
            return null;
        }

        $resolved = $result['data']['player'] ?? null;

        if (! is_array($resolved) || ! isset($resolved['id'], $resolved['npl_id'])) {
            return null;
        }

        DB::table('mirror_players')->updateOrInsert(
            ['cloud_id' => (int) $resolved['id']],
            [
                'npl_id' => (string) $resolved['npl_id'],
                'public_player_code' => $resolved['public_player_code'] ?? null,
                'display_name' => $resolved['display_name'] ?? null,
                'first_name' => $resolved['first_name'] ?? null,
                'last_name' => $resolved['last_name'] ?? null,
                'state_code' => $resolved['state_code'] ?? null,
                'status' => $resolved['status'] ?? 'active',
                'updated_at' => now(),
                'created_at' => now(),
            ],
        );

        return DB::table('mirror_players')->where('cloud_id', (int) $resolved['id'])->first();
    }
}
