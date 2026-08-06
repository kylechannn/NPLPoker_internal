<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Admin-counted chip stacks reach the desk read-only: the service-sync
 * beat pulls the cloud's counts into the local cache, the seating map
 * carries them per seat, and the rail totals only speak for counted
 * players. The cloud is the sole writer — a cloud-side clear empties the
 * desk, while a failed pull keeps what the desk already knows.
 */
class ChipCountPullerTest extends TestCase
{
    use RefreshDatabase;

    private string $dataDir;

    protected function setUp(): void
    {
        parent::setUp();

        $this->dataDir = sys_get_temp_dir().'/npl-internal-test-'.uniqid();
        mkdir($this->dataDir, 0o777, true);
        file_put_contents($this->dataDir.'/license.json', json_encode([
            'key' => 'NPL-TEST-TEST-TEST',
            'device_id' => 'NPLI-TEST',
            'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
        ]));
        putenv('NPL_INTERNAL_DATA_DIR='.$this->dataDir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $this->dataDir;
    }

    protected function tearDown(): void
    {
        @unlink($this->dataDir.'/license.json');
        @rmdir($this->dataDir);
        putenv('NPL_INTERNAL_DATA_DIR');
        unset($_ENV['NPL_INTERNAL_DATA_DIR']);

        parent::tearDown();
    }

    private function tournament(): int
    {
        $result = app(TournamentService::class)->create([
            'name' => 'Thursday Deepstack',
            'venue_name' => 'St George Club',
            'starting_stack' => 20000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 1,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
            ],
        ]);

        return (int) $result['session']['id'];
    }

    private function mirrorPlayer(string $nplId, string $name): void
    {
        DB::table('mirror_players')->insert([
            'cloud_id' => crc32($nplId),
            'npl_id' => $nplId,
            'display_name' => $name,
            'status' => 'active',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    private function fakeCloudCounts(array $counts): void
    {
        Http::fake([
            '*/internal/chip-counts*' => Http::response([
                'ok' => true,
                'data' => [
                    'counts' => $counts,
                    'chip_total' => array_sum(array_column($counts, 'chips')) ?: null,
                    'chip_counted' => count($counts),
                ],
            ]),
            '*/internal/table-service/requests*' => Http::response([
                'ok' => true,
                'data' => ['pending' => [], 'apply' => [], 'recent' => []],
            ]),
            '*' => Http::response(['ok' => true, 'data' => ['tournament' => [], 'broadcast' => false]]),
        ]);
    }

    /** Every entry the seating map knows, seated or standing. */
    private function seatingPlayers(array $seating): array
    {
        $players = array_merge($seating['unseated'], $seating['eliminated']);
        foreach ($seating['tables'] as $table) {
            foreach ($table['seats'] as $seat) {
                if ($seat['player'] !== null) {
                    $players[] = $seat['player'];
                }
            }
        }

        return collect($players)->keyBy('npl_id')->all();
    }

    public function test_pulled_counts_land_on_the_seats_and_in_the_rail(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL6001', 'Alex Chen');
        $this->mirrorPlayer('NPL6002', 'Sam Fold');
        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL6001', 'buy_in', ['first_buy_in' => true]);
        $desk->apply($id, 'NPL6002', 'buy_in', ['first_buy_in' => true]);

        $this->fakeCloudCounts([
            ['npl_id' => 'npl6001', 'chips' => 125500, 'recorded_by' => 'Floor Admin', 'updated_at' => now()->toIso8601String()],
        ]);

        $sync = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');
        $this->assertSame(1, $sync['chip_counts']['counted']);
        $this->assertSame(125500, $sync['chip_counts']['total']);

        $this->assertDatabaseHas('live_chip_counts', [
            'tournament_session_id' => $id,
            'player_npl_id' => 'NPL6001',
            'chips' => 125500,
            'recorded_by' => 'Floor Admin',
        ]);

        // The seat map: the counted player carries the stack, the
        // uncounted one stays null — partial coverage is the normal shape.
        $seating = $this->getJson("/api/v1/desk/{$id}/seating")->assertOk()->json('data');
        $players = $this->seatingPlayers($seating);

        $this->assertSame(125500, $players['NPL6001']['live_chips']);
        $this->assertNotNull($players['NPL6001']['live_chips_at']);
        $this->assertNull($players['NPL6002']['live_chips']);
        $this->assertSame(1, $seating['counts']['counted_players']);
        $this->assertSame(125500, $seating['counts']['counted_chips_total']);
    }

    public function test_a_cloud_clear_empties_the_desk_but_a_failed_pull_keeps_it(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL6001', 'Alex Chen');
        app(TournamentDeskService::class)->apply($id, 'NPL6001', 'buy_in', ['first_buy_in' => true]);

        // One mutable fake for the whole scenario — stacked Http::fake()
        // calls keep the first matching stub, so re-faking mid-test lies.
        $counts = [
            ['npl_id' => 'NPL6001', 'chips' => 40000, 'recorded_by' => 'Floor Admin', 'updated_at' => now()->toIso8601String()],
        ];
        $cloudDown = false;
        Http::fake(function ($request) use (&$counts, &$cloudDown) {
            if ($cloudDown) {
                return Http::response(['ok' => false], 500);
            }
            if (str_contains($request->url(), '/internal/chip-counts')) {
                return Http::response(['ok' => true, 'data' => [
                    'counts' => $counts,
                    'chip_total' => array_sum(array_column($counts, 'chips')) ?: null,
                    'chip_counted' => count($counts),
                ]]);
            }
            if (str_contains($request->url(), '/internal/table-service/requests')) {
                return Http::response(['ok' => true, 'data' => ['pending' => [], 'apply' => [], 'recent' => []]]);
            }

            return Http::response(['ok' => true, 'data' => ['tournament' => [], 'broadcast' => false]]);
        });

        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk();
        $this->assertSame(1, DB::table('live_chip_counts')->count());

        // The admin erased the count on their phone — the desk follows.
        $counts = [];
        $sync = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');
        $this->assertSame(0, $sync['chip_counts']['counted']);
        $this->assertNull($sync['chip_counts']['total']);
        $this->assertSame(0, DB::table('live_chip_counts')->count());

        // Re-seed, then let the cloud go dark: the cache must survive.
        $counts = [
            ['npl_id' => 'NPL6001', 'chips' => 40000, 'recorded_by' => 'Floor Admin', 'updated_at' => now()->toIso8601String()],
        ];
        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk();

        $cloudDown = true;
        $sync = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');
        $this->assertSame(1, $sync['chip_counts']['counted']);
        $this->assertSame(40000, $sync['chip_counts']['total']);
        $this->assertSame(1, DB::table('live_chip_counts')->count());
    }
}
