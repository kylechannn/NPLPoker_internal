<?php

namespace Tests\Feature;

use App\Services\Sync\DeltaSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The backend is the book of record — the mirror must fully cover it.
 * When the cloud's id list names rows this machine never received (rows
 * imported with backdated timestamps sit BEHIND the delta watermark), the
 * sync must notice and force a full re-pull on its own.
 */
class DeltaSelfHealTest extends TestCase
{
    use RefreshDatabase;

    private function player(int $id, string $nplId, string $name): array
    {
        return [
            'id' => $id,
            'npl_id' => $nplId,
            'public_player_code' => 'CARD-'.$id,
            'display_name' => $name,
            'first_name' => $name,
            'last_name' => 'Test',
            'state_code' => 'NSW',
            'avatar_url' => null,
            'status' => 'active',
            'updated_at' => now()->toIso8601String(),
        ];
    }

    public function test_missing_cloud_rows_trigger_one_forced_full_repull(): void
    {
        $fresh = $this->player(2, 'PL0000002', 'Fresh');
        $backdated = $this->player(1, 'PL0000001', 'Backdated');

        Http::fake(function ($request) use ($fresh, $backdated) {
            $url = $request->url();

            if (str_contains($url, '/internal/sync/players/ids')) {
                return Http::response(['ok' => true, 'data' => [
                    'entity' => 'players', 'ids' => [1, 2], 'count' => 2,
                ]], 200);
            }

            if (str_contains($url, '/internal/sync/players')) {
                // A watermarked pull misses the backdated row; only a
                // force pull (no `since`) returns the full truth.
                $withWatermark = str_contains($url, 'since=');

                return Http::response(['ok' => true, 'data' => [
                    'entity' => 'players',
                    'upserts' => $withWatermark ? [$fresh] : [$backdated, $fresh],
                    'next_cursor' => null,
                    'has_more' => false,
                    'count' => $withWatermark ? 1 : 2,
                    'watermark' => now()->toIso8601String(),
                ]], 200);
            }

            return Http::response(['ok' => true, 'data' => []], 200);
        });

        // This machine synced before: a stored watermark makes the next
        // run a delta pull — exactly the state that hides imported rows.
        $service = app(DeltaSyncService::class);
        $service->sync('players');
        DB::table('sync_entity_states')->where('entity', 'players')->update([
            'cursor' => now()->subDay()->toIso8601String(),
            'etag' => null,
        ]);
        DB::table('mirror_players')->where('cloud_id', 1)->delete();
        $this->assertSame(0, (int) DB::table('mirror_players')->where('cloud_id', 1)->count());

        $result = $service->sync('players');

        // The run noticed id 1 was missing, forced a full re-pull, and the
        // mirror now covers the backend completely.
        $this->assertTrue((bool) ($result['healed'] ?? false));
        $this->assertSame(2, (int) DB::table('mirror_players')->count());
        $this->assertSame('Backdated', (string) DB::table('mirror_players')->where('cloud_id', 1)->value('display_name'));
    }
}
