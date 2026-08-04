<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Phone rebuys land in the LOCAL ledger: the admin resolves at the table,
 * the desk pulls it, applies it exactly like a desk scan, and acks the
 * verdict — replay-proof through the ledger's idempotency key.
 */
class TableServicePullerTest extends TestCase
{
    use RefreshDatabase;

    private string $dataDir;

    protected function setUp(): void
    {
        parent::setUp();

        // A real licence lease so LicenseKeyProvider (and the broadcaster's
        // activation guard) run their genuine paths.
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

    private function tournament(array $overrides = []): int
    {
        $result = app(TournamentService::class)->create(array_merge([
            'name' => 'Thursday Deepstack',
            'venue_name' => 'St George Club',
            'starting_stack' => 20000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 3,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
                ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'duration_min' => 20],
            ],
        ], $overrides));

        return (int) $result['session']['id'];
    }

    private function mirrorPlayer(string $nplId, string $name = 'Test Player'): void
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

    private function fakeCloud(array $applyRows, array $pendingRows = []): void
    {
        Http::fake([
            '*/internal/table-service/requests/*/applied' => Http::response([
                'ok' => true,
                'data' => ['request' => ['id' => 0]],
            ]),
            '*/internal/table-service/requests/*/resolve' => Http::response([
                'ok' => true,
                'data' => ['request' => ['id' => 0]],
            ]),
            '*/internal/table-service/requests*' => Http::response([
                'ok' => true,
                'data' => ['pending' => $pendingRows, 'apply' => $applyRows, 'recent' => []],
            ]),
            '*' => Http::response(['ok' => true, 'data' => ['tournament' => [], 'broadcast' => false]]),
        ]);
    }

    public function test_a_resolved_phone_rebuy_lands_in_the_ledger_once_and_is_acked(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL5001', 'Alex Chen');

        app(TournamentDeskService::class)->apply($id, 'NPL5001', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);

        $this->fakeCloud([
            ['id' => 77, 'npl_id' => 'NPL5001', 'kind' => 'rebuy', 'table_number' => 3],
        ]);

        $result = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');

        $this->assertCount(1, $result['applied']);
        $this->assertSame('NPL5001', $result['applied'][0]['npl_id']);
        $this->assertDatabaseHas('tournament_actions', [
            'action' => 'rebuy',
            'idempotency_key' => 'tsr:77',
        ]);

        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/77/applied')
            && $request['ok'] === true);

        // A lost ack means the same row comes back — the ledger swallows
        // the duplicate, so the rebuy still counts exactly once.
        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk();

        $this->assertSame(1, DB::table('tournament_actions')->where('action', 'rebuy')->count());
    }

    public function test_a_cap_refusal_is_acked_as_a_permanent_failure(): void
    {
        $id = $this->tournament(['max_rebuys_per_player' => 1]);
        $this->mirrorPlayer('NPL5002', 'Sam Fold');

        app(TournamentDeskService::class)->apply($id, 'NPL5002', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);
        app(TournamentDeskService::class)->apply($id, 'NPL5002', 'rebuy', []);

        $this->fakeCloud([
            ['id' => 88, 'npl_id' => 'NPL5002', 'kind' => 'rebuy', 'table_number' => 1],
        ]);

        $result = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');

        $this->assertCount(0, $result['applied']);
        $this->assertCount(1, $result['failed']);
        $this->assertStringContainsString('rebuys', $result['failed'][0]['error']);

        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/88/applied')
            && $request['ok'] === false);
    }

    public function test_the_desk_panel_sees_the_pending_queue_in_the_same_pull(): void
    {
        $id = $this->tournament();

        $this->fakeCloud([], [
            ['id' => 5, 'npl_id' => 'NPL9001', 'kind' => 'assistance', 'note' => 'Chip change', 'table_number' => 2],
        ]);

        $result = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');

        $this->assertCount(1, $result['pending']);
        $this->assertSame('assistance', $result['pending'][0]['kind']);
        $this->assertSame('Chip change', $result['pending'][0]['note']);
    }

    public function test_the_desk_handles_a_money_request_itself_ledger_first_then_the_cloud(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL5003', 'Riva Splash');

        app(TournamentDeskService::class)->apply($id, 'NPL5003', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);

        $this->fakeCloud([], [
            ['id' => 91, 'npl_id' => 'NPL5003', 'kind' => 'rebuy', 'table_number' => 1],
        ]);

        $this->postJson("/api/v1/desk/{$id}/service-handle", ['request_id' => 91])
            ->assertOk()
            ->assertJsonPath('data.handled.kind', 'rebuy');

        $this->assertDatabaseHas('tournament_actions', [
            'action' => 'rebuy',
            'idempotency_key' => 'tsr:91',
        ]);

        // The cloud learns it arrived already applied, priced by the desk.
        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/91/resolve')
            && $request['applied'] === true
            && $request['amount_cents'] === 5000);
    }

    public function test_the_desk_resolves_assistance_without_touching_the_ledger(): void
    {
        $id = $this->tournament();

        $this->fakeCloud([], [
            ['id' => 92, 'npl_id' => 'NPL9002', 'kind' => 'assistance', 'table_number' => 4],
        ]);

        $this->postJson("/api/v1/desk/{$id}/service-handle", ['request_id' => 92])->assertOk();

        $this->assertSame(0, DB::table('tournament_actions')->count());

        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/92/resolve')
            && $request['applied'] === false);
    }
}
