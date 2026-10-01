<?php

namespace Tests\Feature;

use App\Services\Sync\OutboxService;
use App\Services\Tournament\CashTableMovePuller;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class CashTableMoveTest extends TestCase
{
    use RefreshDatabase;

    private string $dataDir;
    private int $sessionId;
    private ?\Closure $cloudResponse = null;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
        $this->dataDir = sys_get_temp_dir().'/npl-cash-move-test-'.uniqid();
        mkdir($this->dataDir);
        file_put_contents($this->dataDir.'/license.json', json_encode([
            'key' => 'NPL-TEST-TEST-TEST', 'device_id' => 'NPLI-TEST',
            'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
        ]));
        putenv('NPL_INTERNAL_DATA_DIR='.$this->dataDir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $this->dataDir;
        Http::fake(fn ($request) => $this->cloudResponse ? ($this->cloudResponse)($request) : Http::response(['ok' => true, 'data' => []]));
        $this->sessionId = app(TournamentService::class)->create([
            'name' => 'Cash', 'venue_name' => 'Test', 'game_type' => 'cash', 'game_session_id' => 701,
            'starting_stack' => 20000, 'seats_per_table' => 8,
            'levels' => [['level_no' => 1, 'type' => 'blind', 'small_blind' => 1, 'big_blind' => 2, 'duration_min' => 20]],
        ])['session']['id'];
        DB::table('tournament_entries')->insert([
            'tournament_session_id' => $this->sessionId, 'player_npl_id' => 'CASH1',
            'table_number' => 1, 'seat_number' => 2, 'status' => 'active', 'cash_registration_id' => 11,
            'cash_version' => 0, 'created_at' => now(), 'updated_at' => now(),
        ]);
        DB::table('tournament_actions')->insert([
            'tournament_session_id' => $this->sessionId, 'player_npl_id' => 'CASH1',
            'action' => 'buy_in', 'chips' => 20000, 'price_cents' => 5000, 'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    protected function tearDown(): void
    {
        @unlink($this->dataDir.'/license.json');
        @rmdir($this->dataDir);
        putenv('NPL_INTERNAL_DATA_DIR');
        unset($_ENV['NPL_INTERNAL_DATA_DIR']);
        parent::tearDown();
    }

    private function move(): array
    {
        return ['id' => 51, 'player_npl_id' => 'CASH1', 'from_registration_id' => 11,
            'from_table_number' => 1, 'from_seat_number' => 2, 'to_registration_id' => 12,
            'to_table_number' => 2, 'to_seat_number' => 3, 'expected_version' => 0, 'version' => 1, 'status' => 'pending'];
    }

    public function test_cash_move_changes_only_the_seat_and_retries_a_lost_ack_without_charging(): void
    {
        $calls = 0;
        $this->cloudResponse = function ($request) use (&$calls) {
            if (str_contains($request->url(), '/cash-table-moves/51/ack')) {
                $calls++;
                return $calls === 1 ? Http::response(['ok' => false], 503)
                    : Http::response(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'applied', 'version' => 1]]]);
            }
            return Http::response(['ok' => true, 'data' => ['data' => $calls ? [] : [$this->move()]]]);
        };
        $first = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertSame([51], $first['pending']);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 2, 'seat_number' => 3]);
        $second = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertCount(1, $second['applied']);
        $this->assertDatabaseHas('cash_table_moves', ['id' => 51, 'status' => 'completed']);
        $this->assertSame(2, $calls);
        $this->assertSame(1, DB::table('tournament_actions')->count());
        $this->assertSame(20000, (int) DB::table('tournament_actions')->sum('chips'));
        $this->assertSame(5000, (int) DB::table('tournament_actions')->sum('price_cents'));
    }

    public function test_an_occupied_destination_keeps_the_previous_seat(): void
    {
        DB::table('tournament_entries')->insert([
            'tournament_session_id' => $this->sessionId, 'player_npl_id' => 'OTHER',
            'table_number' => 2, 'seat_number' => 3, 'status' => 'active', 'created_at' => now(), 'updated_at' => now(),
        ]);
        $this->cloudResponse = function ($request) {
            if (str_contains($request->url(), '/ack')) {
                $this->assertSame('failed', $request['status']);
                return Http::response(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'failed', 'version' => 1]]]);
            }
            return Http::response(['ok' => true, 'data' => ['data' => [$this->move()]]]);
        };
        $result = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertCount(1, $result['failed']);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 1, 'seat_number' => 2]);
    }

    public function test_a_304_feed_still_retries_a_lost_cash_ack_without_moving_or_charging_twice(): void
    {
        $acks = 0;
        $reads = 0;
        $this->cloudResponse = function ($request) use (&$acks, &$reads) {
            if (str_contains($request->url(), '/cash-table-moves/51/ack')) {
                return ++$acks === 1 ? Http::response(['ok' => false], 503)
                    : Http::response(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'applied', 'version' => 1]]]);
            }
            if (str_contains($request->url(), '/cash-table-moves')) {
                if (++$reads > 1) {
                    $this->assertSame('W/"moves"', $request->header('If-None-Match')[0] ?? null);
                    return Http::response('', 304);
                }
                return Http::response(['ok' => true, 'data' => ['data' => [$this->move()]]], 200, ['ETag' => 'W/"moves"']);
            }
            return Http::response(['ok' => true, 'data' => []]);
        };
        $this->assertSame([51], app(CashTableMovePuller::class)->sync($this->sessionId)['pending']);
        $this->assertCount(1, app(CashTableMovePuller::class)->sync($this->sessionId)['applied']);
        $this->assertSame(2, $acks);
        $this->assertDatabaseHas('cash_table_moves', ['id' => 51, 'status' => 'completed']);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 2, 'seat_number' => 3]);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    #[\PHPUnit\Framework\Attributes\DataProvider('invalidAcknowledgements')]
    public function test_unconfirmed_ack_stays_pending_and_retries_without_another_move(array $answer): void
    {
        $calls = 0;
        $keys = [];
        $this->cloudResponse = function ($request) use (&$calls, &$keys, $answer) {
            if (str_contains($request->url(), '/cash-table-moves/51/ack')) {
                $keys[] = $request->header('Idempotency-Key')[0];
                return Http::response(['ok' => true, 'data' => ++$calls === 1 ? $answer
                    : ['move' => ['id' => 51, 'status' => 'applied', 'version' => 1, 'local_reference' => 'cash-move:51']]]);
            }
            return Http::response(['ok' => true, 'data' => ['data' => $calls ? [] : [$this->move()]]]);
        };
        $this->assertSame([51], app(CashTableMovePuller::class)->sync($this->sessionId)['pending']);
        $this->assertDatabaseHas('cash_table_moves', ['id' => 51, 'status' => 'applied_pending']);
        $this->assertCount(1, app(CashTableMovePuller::class)->sync($this->sessionId)['applied']);
        $this->assertSame($keys[0], $keys[1]);
        $this->assertDatabaseHas('cash_table_moves', ['id' => 51, 'status' => 'completed']);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public static function invalidAcknowledgements(): array
    {
        return [
            'missing move' => [[]],
            'wrong move' => [['move' => ['id' => 52, 'status' => 'applied', 'version' => 1]]],
            'not confirmed' => [['move' => ['id' => 51, 'status' => 'pending', 'version' => 1]]],
            'missing version' => [['move' => ['id' => 51, 'status' => 'applied']]],
            'wrong operation' => [['move' => ['id' => 51, 'status' => 'applied', 'version' => 1, 'local_reference' => 'different']]],
        ];
    }

    public function test_a_license_change_during_feed_fetch_cannot_apply_or_ack_the_old_feed(): void
    {
        $this->cloudResponse = function ($request) {
            $this->assertFalse(str_contains($request->url(), '/ack'));
            file_put_contents($this->dataDir.'/license.json', json_encode([
                'key' => 'DIFFERENT-LICENSE', 'device_id' => 'OTHER-DESK',
                'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
            ]));
            return Http::response(['ok' => true, 'data' => ['data' => [$this->move()]]]);
        };
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseCount('cash_table_moves', 0);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 1, 'seat_number' => 2]);
    }

    public function test_replacing_the_licence_never_reuses_a_previous_devices_conditional_cache(): void
    {
        $reads = 0;
        $this->cloudResponse = function ($request) use (&$reads) {
            if (str_contains($request->url(), '/cash-table-moves')) {
                $reads++;
                $this->assertFalse($request->hasHeader('If-None-Match'));
                return Http::response(['ok' => true, 'data' => ['data' => []]], 200, ['ETag' => 'W/"private-feed"']);
            }
            return Http::response(['ok' => true, 'data' => []]);
        };
        app(CashTableMovePuller::class)->sync($this->sessionId);
        file_put_contents($this->dataDir.'/license.json', json_encode([
            'key' => 'DIFFERENT-LICENSE', 'device_id' => 'OTHER-DESK',
            'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
        ]));
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertSame(2, $reads);
    }

    public function test_a_session_relink_during_feed_fetch_cannot_apply_the_old_feed(): void
    {
        $this->cloudResponse = function ($request) {
            $this->assertFalse(str_contains($request->url(), '/ack'));
            DB::table('tournament_sessions')->where('id', $this->sessionId)->update(['game_session_id' => 702]);
            return Http::response(['ok' => true, 'data' => ['data' => [$this->move()]]]);
        };
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseCount('cash_table_moves', 0);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public function test_a_resident_cloud_client_refreshes_its_license_headers_before_the_next_request(): void
    {
        $keys = [];
        $this->cloudResponse = function ($request) use (&$keys) {
            $keys[] = $request->header('X-CD-Key')[0];
            return Http::response(['ok' => true, 'data' => []]);
        };
        $client = app(\App\Services\Cloud\CloudClient::class);
        $client->getJson('/api/v1/internal/test-identity');
        file_put_contents($this->dataDir.'/license.json', json_encode([
            'key' => 'NEW-LICENSE', 'device_id' => 'NEW-DEVICE',
            'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
        ]));
        $client->getJson('/api/v1/internal/test-identity');
        $this->assertSame(['NPL-TEST-TEST-TEST', 'NEW-LICENSE'], $keys);
    }

    public function test_daily_tournaments_do_not_pull_cash_moves(): void
    {
        DB::table('tournament_sessions')->where('id', $this->sessionId)->update(['game_type' => 'tournament']);
        Http::fake();
        $this->assertSame(['applied' => [], 'failed' => [], 'pending' => []], app(CashTableMovePuller::class)->sync($this->sessionId));
        Http::assertNothingSent();
    }

    public function test_a_cloud_rejection_restores_the_old_local_seat(): void
    {
        $this->cloudResponse = fn ($request) => Http::response(['ok' => true, 'data' => str_contains($request->url(), '/ack')
            ? ['move' => ['id' => 51, 'status' => 'failed', 'version' => 1, 'reason' => 'The table closed.']]
            : ['data' => [$this->move()]]]);
        $result = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertCount(1, $result['failed']);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 1, 'seat_number' => 2, 'cash_registration_id' => 11]);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public function test_authoritative_position_recovers_an_old_offline_seat_without_changing_money(): void
    {
        $this->cloudResponse = fn () => Http::response(['ok' => true, 'data' => ['data' => [], 'positions' => [[
            'player_npl_id' => 'CASH1', 'current_registration_id' => 12, 'table_number' => 2, 'seat_number' => 3, 'version' => 2,
        ]]]]);
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'table_number' => 2, 'seat_number' => 3, 'cash_version' => 2]);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public function test_cash_seating_keeps_other_table_reservations_visible_after_buy_in(): void
    {
        foreach ([1, 2] as $table) {
            DB::table('mirror_session_tables')->insert([
                'session_table_key' => '701:'.$table.':2', 'session_id' => 701, 'table_number' => $table,
                'seat_number' => 2, 'max_seats' => 8, 'table_status' => 'open', 'table_kind' => 'house',
                'player_npl_id' => 'CASH1', 'player_display_name' => 'Cash Player', 'registration_status' => 'registered',
                'registration_id' => $table + 10, 'cash_seat_state' => $table === 1 ? 'active' : 'reserved',
                'created_at' => now(), 'updated_at' => now(),
            ]);
        }
        $seating = app(TournamentDeskService::class)->seating($this->sessionId);
        $this->assertNotNull($seating['tables'][0]['seats'][1]['player']);
        $this->assertSame('online', $seating['tables'][1]['seats'][1]['player']['status']);
        $this->assertSame('CASH1', $seating['tables'][1]['seats'][1]['player']['npl_id']);
    }

    public function test_a_removal_before_the_phone_move_is_pulled_recovers_the_paid_entry_after_cloud_rejection(): void
    {
        $acked = false;
        $position = ['player_npl_id' => 'CASH1', 'current_registration_id' => 11,
            'table_number' => 1, 'seat_number' => 2, 'version' => 1];
        $this->cloudResponse = function ($request) use (&$acked, $position) {
            if (str_contains($request->url(), '/internal/outbox')) {
                $cancel = $request['entity_type'] === 'session_registration_cancel';
                return Http::response(['ok' => true, 'data' => ['result' => [
                    'applied' => ! $cancel,
                    'detail' => ['reason' => 'Cash seating changed. Refresh the desk.', 'retryable' => false],
                ]]]);
            }
            if (str_contains($request->url(), '/cash-table-moves/51/ack')) {
                $this->assertSame('failed', $request['status']);
                $acked = true;
                return Http::response(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'failed', 'version' => 1]]]);
            }
            if (str_contains($request->url(), '/cash-table-moves')) {
                return Http::response(['ok' => true, 'data' => ['data' => $acked ? [] : [$this->move()], 'positions' => [$position]]]);
            }
            return Http::response(['ok' => true, 'data' => []]);
        };

        app(TournamentDeskService::class)->removePlayer($this->sessionId, 'CASH1');
        $this->assertDatabaseMissing('tournament_entries', ['player_npl_id' => 'CASH1']);
        $this->assertDatabaseCount('cash_entry_recoveries', 1);
        $first = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertCount(1, $first['failed']);
        // This pull still carried a moving player; restore on the next fresh position feed.
        $this->assertDatabaseMissing('tournament_entries', ['player_npl_id' => 'CASH1']);
        app(OutboxService::class)->drain(100);
        $this->assertDatabaseHas('sync_outbox', ['entity_type' => 'session_registration_cancel', 'status' => 'dead']);

        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseHas('tournament_entries', ['tournament_session_id' => $this->sessionId,
            'player_npl_id' => 'CASH1', 'status' => 'active', 'table_number' => 1, 'seat_number' => 2,
            'cash_registration_id' => 11, 'cash_version' => 1]);
        $this->assertDatabaseCount('cash_entry_recoveries', 0);
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseCount('tournament_entries', 1);
        $this->assertDatabaseCount('tournament_actions', 1);
        $this->assertSame(5000, (int) DB::table('tournament_actions')->sum('price_cents'));
        $this->assertSame(20000, (int) DB::table('tournament_actions')->sum('chips'));
    }

    public function test_a_rejected_cash_elimination_restores_the_existing_entry_without_another_buy_in(): void
    {
        $entryId = DB::table('tournament_entries')->where('player_npl_id', 'CASH1')->value('id');
        $this->cloudResponse = function ($request) {
            if (str_contains($request->url(), '/internal/outbox')) {
                return Http::response(['ok' => true, 'data' => ['result' => [
                    'applied' => $request['entity_type'] !== 'session_seat_change',
                    'detail' => ['reason' => 'Cash seating changed. Refresh the desk.', 'retryable' => false],
                ]]]);
            }
            if (str_contains($request->url(), '/cash-table-moves')) {
                return Http::response(['ok' => true, 'data' => ['data' => [], 'positions' => [[
                    'player_npl_id' => 'CASH1', 'current_registration_id' => 11,
                    'table_number' => 1, 'seat_number' => 2, 'version' => 1,
                ]]]]);
            }
            return Http::response(['ok' => true, 'data' => []]);
        };
        app(TournamentDeskService::class)->eliminate($this->sessionId, 'CASH1');
        $this->assertDatabaseHas('tournament_entries', ['id' => $entryId, 'status' => 'eliminated']);
        $this->assertDatabaseCount('cash_entry_recoveries', 1);
        app(OutboxService::class)->drain(100);
        $this->assertDatabaseHas('sync_outbox', ['entity_type' => 'session_seat_change', 'status' => 'dead']);

        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseHas('tournament_entries', ['id' => $entryId, 'status' => 'active',
            'table_number' => 1, 'seat_number' => 2, 'eliminated_at' => null, 'finish_position' => null,
            'cash_registration_id' => 11, 'cash_version' => 1]);
        $this->assertDatabaseCount('cash_entry_recoveries', 0);
        app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertDatabaseCount('tournament_entries', 1);
        $this->assertSame(1, DB::table('tournament_actions')->where('action', 'buy_in')->count());
        $this->assertDatabaseCount('tournament_actions', 2); // Original buy-in plus the attempted KO.
        $this->assertSame(5000, (int) DB::table('tournament_actions')->sum('price_cents'));
        $this->assertSame(20000, (int) DB::table('tournament_actions')->sum('chips'));
    }

    public function test_an_unchecked_selected_cloud_position_unseats_a_stale_paid_entry_without_charging(): void
    {
        $this->cloudResponse = fn () => Http::response(['ok' => true, 'data' => ['data' => [], 'positions' => [[
            'player_npl_id' => 'CASH1', 'current_registration_id' => null,
            'selected_registration_id' => 12, 'cash_seat_state' => 'selected',
            'table_number' => null, 'seat_number' => null, 'version' => 2,
        ]]]]);
        $result = app(CashTableMovePuller::class)->sync($this->sessionId);
        $this->assertSame([['npl_id' => 'CASH1', 'table_number' => null, 'seat_number' => null]], $result['reconciled']);
        $this->assertDatabaseHas('tournament_entries', ['player_npl_id' => 'CASH1', 'status' => 'active',
            'table_number' => null, 'seat_number' => null, 'cash_registration_id' => null, 'cash_version' => 2]);
        $this->assertArrayNotHasKey('reconciled', app(CashTableMovePuller::class)->sync($this->sessionId));
        $this->assertDatabaseCount('tournament_entries', 1);
        $this->assertDatabaseCount('tournament_actions', 1);
        $this->assertSame(5000, (int) DB::table('tournament_actions')->sum('price_cents'));
        $this->assertSame(20000, (int) DB::table('tournament_actions')->sum('chips'));
    }
}
