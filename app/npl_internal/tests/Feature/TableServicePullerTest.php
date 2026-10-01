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
        Http::preventStrayRequests();
        config(['nplcloud.host_bridge' => 'http://127.0.0.1:65500']);

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

    private function fakeCloud(array $applyRows, array $pendingRows = [], array $entitlement = [], int $entitlementStatus = 200, int $confirmationStatus = 200, ?array $confirmedCoverage = null): void
    {
        // service-sync reads the combined desk-pulse; the standalone
        // requests feed stays faked for the desk-handle path, which still
        // reads it directly.
        Http::fake([
            '*/internal/vouchers/entitlement*' => Http::response(['ok' => true, 'data' => $entitlement], $entitlementStatus),
            '*/internal/vouchers/confirm-entry' => Http::response($confirmationStatus === 200
                ? ['ok' => true, 'data' => ['entry_confirmed' => true, 'already_covered' => $confirmedCoverage ?? $entitlement['already_covered'] ?? null,
                    'entry_fee_cents' => $confirmedCoverage['entry_fee_cents'] ?? $entitlement['already_covered']['entry_fee_cents'] ?? $entitlement['entry_fee_cents'] ?? 10000]]
                : ['ok' => false, 'error' => ['code' => 'PAYMENT_CANCELLED', 'message' => 'The covered entry was cancelled before confirmation.']], $confirmationStatus),
            '*/internal/desk-pulse*' => Http::response([
                'ok' => true,
                'data' => [
                    'service' => ['pending' => $pendingRows, 'apply' => $applyRows, 'recent' => []],
                    'chip_counts' => ['counts' => [], 'chip_total' => null, 'chip_counted' => 0],
                ],
            ]),
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
        $this->fakeCloud([
            ['id' => 77, 'npl_id' => 'NPL5001', 'kind' => 'rebuy', 'table_number' => 3],
        ]);

        $id = $this->tournament();
        $this->mirrorPlayer('NPL5001', 'Alex Chen');

        app(TournamentDeskService::class)->apply($id, 'NPL5001', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);

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
        $this->fakeCloud([
            ['id' => 88, 'npl_id' => 'NPL5002', 'kind' => 'rebuy', 'table_number' => 1],
        ]);

        $id = $this->tournament(['max_rebuys_per_player' => 1]);
        $this->mirrorPlayer('NPL5002', 'Sam Fold');

        app(TournamentDeskService::class)->apply($id, 'NPL5002', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);
        app(TournamentDeskService::class)->apply($id, 'NPL5002', 'rebuy', []);

        $result = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');

        $this->assertCount(0, $result['applied']);
        $this->assertCount(1, $result['failed']);
        $this->assertStringContainsString('rebuys', $result['failed'][0]['error']);

        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/88/applied')
            && $request['ok'] === false);
    }

    public function test_the_desk_panel_sees_the_pending_queue_in_the_same_pull(): void
    {
        $this->fakeCloud([], [
            ['id' => 5, 'npl_id' => 'NPL9001', 'kind' => 'assistance', 'note' => 'Chip change', 'table_number' => 2],
        ]);

        $id = $this->tournament();

        $result = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');

        $this->assertCount(1, $result['pending']);
        $this->assertSame('assistance', $result['pending'][0]['kind']);
        $this->assertSame('Chip change', $result['pending'][0]['note']);
    }

    public function test_the_desk_handles_a_money_request_itself_ledger_first_then_the_cloud(): void
    {
        $this->fakeCloud([], [
            ['id' => 91, 'npl_id' => 'NPL5003', 'kind' => 'rebuy', 'table_number' => 1],
        ]);

        $id = $this->tournament();
        $this->mirrorPlayer('NPL5003', 'Riva Splash');

        app(TournamentDeskService::class)->apply($id, 'NPL5003', 'buy_in', ['first_buy_in' => true]);
        app(TournamentClockService::class)->start($id);

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
        $this->fakeCloud([], [
            ['id' => 92, 'npl_id' => 'NPL9002', 'kind' => 'assistance', 'table_number' => 4],
        ]);

        $id = $this->tournament();

        $this->postJson("/api/v1/desk/{$id}/service-handle", ['request_id' => 92])->assertOk();

        $this->assertSame(0, DB::table('tournament_actions')->count());

        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/92/resolve')
            && $request['applied'] === false);
    }

    private function linkCloudSession(int $localId, bool $mainEvent = true): void
    {
        DB::table('mirror_game_sessions')->insert([
            'session_id' => 9001,
            'source_type' => $mainEvent ? 'championship' : 'daily_game',
            'venue_id' => 91,
            'venue_name' => 'St George Club',
            'title' => $mainEvent ? 'SPO Flight 1' : 'Daily Game',
            'session_date' => '2026-10-10',
            'start_time' => '18:30:00',
            'payload' => json_encode(['ticket_redemption_enabled' => $mainEvent]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        DB::table('tournament_sessions')->where('id', $localId)->update(['game_session_id' => 9001, 'venue_id' => 91]);
    }

    private function ticketCoverage(int $count): array
    {
        $tickets = array_map(fn (int $id): array => [
            'voucher_id' => $id, 'code' => 'SPO'.$id, 'type' => 'special_ticket', 'title' => 'SPO ticket',
            'value_cents' => 25000, 'entry_fee_limit_cents' => null,
        ], range(1, $count));

        return [
            'entitled' => false,
            'ticket_redemption_enabled' => true,
            'already_covered' => $tickets[0] + [
                'vouchers' => $tickets,
                'entry_fee_cents' => 75000,
                'covered_cents' => min(75000, $count * 25000),
                'deficit_cents' => max(0, 75000 - $count * 25000),
            ],
        ];
    }

    public function test_phone_resolved_ticket_buy_in_books_only_confirmed_deficit_and_acks_recorded_amount(): void
    {
        $this->fakeCloud([
            ['id' => 201, 'npl_id' => 'NPLSPO1', 'kind' => 'buy_in', 'table_number' => 1],
        ], [], $this->ticketCoverage(2));
        $id = $this->tournament(['buy_in_price_cents' => 100000]);
        $this->mirrorPlayer('NPLSPO1', 'Ticket Player');
        $this->linkCloudSession($id);

        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()
            ->assertJsonPath('data.applied.0.amount_cents', 25000);
        $action = DB::table('tournament_actions')->where('idempotency_key', 'tsr:201')->first();
        $this->assertSame(25000, (int) $action->price_cents);
        $meta = json_decode($action->meta, true);
        $this->assertSame(['SPO1', 'SPO2'], $meta['voucher_codes']);
        $this->assertSame(75000, $meta['voucher_entry_fee_cents']);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/vouchers/confirm-entry')
            && $request['npl_id'] === 'NPLSPO1' && $request['game_session_id'] === 9001 && $request['reference'] === 'tsr:201');
        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/201/applied')
            && $request['ok'] === true && $request['amount_cents'] === 25000);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/api/print/receipt')
            && str_contains(implode('\n', array_column($request['lines'], 'text')), 'Paid at desk: $250.00'));

        // A lost cloud acknowledgement must not re-price or duplicate the recorded buy-in.
        DB::table('tournament_sessions')->where('id', $id)->update(['buy_in_price_cents' => 150000]);
        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()
            ->assertJsonPath('data.applied.0.amount_cents', 25000);
        $this->assertSame(1, DB::table('tournament_actions')->where('idempotency_key', 'tsr:201')->count());
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/vouchers/redeem'));
    }

    public function test_desk_handled_phone_request_reports_free_ticket_entry_and_prints_zero(): void
    {
        $this->fakeCloud([], [
            ['id' => 202, 'npl_id' => 'NPLSPO2', 'kind' => 'buy_in', 'table_number' => 1],
        ], $this->ticketCoverage(3));
        $id = $this->tournament(['buy_in_price_cents' => 75000]);
        $this->mirrorPlayer('NPLSPO2', 'Free Ticket Player');
        $this->linkCloudSession($id);

        $this->postJson("/api/v1/desk/{$id}/service-handle", ['request_id' => 202])->assertOk();
        $this->assertDatabaseHas('tournament_actions', ['idempotency_key' => 'tsr:202', 'price_cents' => 0]);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/202/resolve')
            && $request['applied'] === true && $request['amount_cents'] === 0);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/api/print/receipt')
            && str_contains(implode('\n', array_column($request['lines'], 'text')), 'Tickets cover: $750.00')
            && str_contains(implode('\n', array_column($request['lines'], 'text')), 'Paid at desk: $0.00'));
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/vouchers/redeem'));
    }

    public function test_phone_buy_in_honours_an_online_free_voucher_on_an_ordinary_daily_game(): void
    {
        $this->fakeCloud([], [
            ['id' => 203, 'npl_id' => 'NPLFREE1', 'kind' => 'buy_in', 'table_number' => 1],
        ], ['entitled' => false, 'ticket_redemption_enabled' => false, 'already_covered' => [
            'voucher_id' => 30, 'code' => 'FREE30', 'type' => 'game_entry', 'title' => 'Free entry',
            'entry_fee_limit_cents' => null, 'covered_cents' => null, 'deficit_cents' => null,
        ]]);
        $id = $this->tournament(['buy_in_price_cents' => 10000]);
        $this->mirrorPlayer('NPLFREE1', 'Free Daily Player');
        $this->linkCloudSession($id, false);

        $this->postJson("/api/v1/desk/{$id}/service-handle", ['request_id' => 203])->assertOk();
        $this->assertDatabaseHas('tournament_actions', ['idempotency_key' => 'tsr:203', 'price_cents' => 0]);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/table-service/requests/203/resolve')
            && $request['amount_cents'] === 0);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/api/print/receipt')
            && str_contains(implode('\n', array_column($request['lines'], 'text')), 'Voucher: FREE30 ($100.00 covered)'));
    }

    public function test_plain_main_event_buy_in_claims_and_uses_the_confirmed_cash_fee(): void
    {
        $this->fakeCloud([
            ['id' => 206, 'npl_id' => 'NPLCASH1', 'kind' => 'buy_in', 'table_number' => 1],
        ], [], ['ticket_redemption_enabled' => true, 'entry_fee_cents' => 50000, 'already_covered' => null]);
        $id = $this->tournament(['buy_in_price_cents' => 75000]);
        $this->mirrorPlayer('NPLCASH1', 'Cash Main Player');
        $this->linkCloudSession($id);
        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->assertJsonPath('data.applied.0.amount_cents', 50000);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/vouchers/confirm-entry')
            && $request['require_coverage'] === false && $request['cash_fee_cents'] === 75000);
        $this->assertDatabaseHas('tournament_actions', ['idempotency_key' => 'tsr:206', 'price_cents' => 50000]);
    }

    public function test_tickets_paid_after_scan_replace_a_plain_cash_fee_at_confirmation(): void
    {
        $this->fakeCloud([
            ['id' => 207, 'npl_id' => 'NPLRACE1', 'kind' => 'buy_in', 'table_number' => 1],
        ], [], ['ticket_redemption_enabled' => true, 'already_covered' => null], 200, 200,
            $this->ticketCoverage(2)['already_covered']);
        $id = $this->tournament(['buy_in_price_cents' => 75000]);
        $this->mirrorPlayer('NPLRACE1', 'Concurrent Ticket Player');
        $this->linkCloudSession($id);
        $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->assertJsonPath('data.applied.0.amount_cents', 25000);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/vouchers/confirm-entry') && $request['require_coverage'] === false);
        $this->assertDatabaseHas('tournament_actions', ['idempotency_key' => 'tsr:207', 'price_cents' => 25000]);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/api/print/receipt')
            && str_contains(implode('\n', array_column($request['lines'], 'text')), 'Tickets cover: $500.00'));
    }

    public function test_cancelled_coverage_cannot_be_booked_between_entitlement_and_confirmation(): void
    {
        $this->fakeCloud([
            ['id' => 205, 'npl_id' => 'NPLCANCEL1', 'kind' => 'buy_in', 'table_number' => 1],
        ], [], $this->ticketCoverage(3), 200, 422);
        $id = $this->tournament();
        $this->mirrorPlayer('NPLCANCEL1', 'Cancelled Player');
        $this->linkCloudSession($id);
        $response = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');
        $this->assertSame([], $response['applied']);
        $this->assertSame(205, $response['failed'][0]['id']);
        $this->assertDatabaseCount('tournament_actions', 0);
        $this->assertDatabaseCount('tournament_entries', 0);
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/api/print/receipt'));
    }

    public function test_a_phone_buy_in_waits_for_coverage_after_a_temporary_cloud_failure(): void
    {
        $this->fakeCloud([
            ['id' => 204, 'npl_id' => 'NPLWAIT1', 'kind' => 'buy_in', 'table_number' => 1],
        ], [], [], 503);
        $id = $this->tournament();
        $this->mirrorPlayer('NPLWAIT1', 'Retry Player');
        $this->linkCloudSession($id, false);

        $response = $this->postJson("/api/v1/desk/{$id}/service-sync")->assertOk()->json('data');
        $this->assertSame([], $response['applied']);
        $this->assertSame([], $response['failed']);
        $this->assertSame(0, DB::table('tournament_actions')->count());
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/table-service/requests/204/applied'));
        Http::assertNotSent(fn ($request) => str_contains($request->url(), '/api/print/receipt'));
    }
}
