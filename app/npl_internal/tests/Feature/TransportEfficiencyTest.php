<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudException;
use App\Services\Cloud\ConditionalCloudRead;
use App\Services\Sync\SyncService;
use App\Support\MirrorTableTimer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TransportEfficiencyTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
    }

    private function snapshot(int $id, int $metadataStatus = 200): array
    {
        return [
            'game_session_id' => $id, 'metadata_status' => $metadataStatus, 'seating_status' => 200,
            'session' => $metadataStatus === 200 ? ['id' => $id, 'venue_id' => 7, 'title' => 'Cash '.$id, 'status' => 'scheduled', 'session_date' => '2026-10-02'] : null,
            'seating' => ['session_id' => $id, 'tables' => [[
                'table_number' => 1, 'status' => 'open', 'phase' => 'live', 'kind' => 'house',
                'timer_running' => true, 'live_elapsed_ms' => 1000,
                'seats' => [['seat_number' => 1, 'player' => ['npl_id' => 'PLAYER'.$id, 'display_name' => 'Player']]],
            ]]],
        ];
    }

    public function test_two_target_sessions_use_one_cloud_request_and_leave_other_mirrors_alone(): void
    {
        DB::table('mirror_game_sessions')->insert(['session_id' => 999, 'title' => 'Other venue', 'venue_id' => 8]);
        Http::fake(function ($request) {
            $this->assertStringContainsString('/internal/sessions/snapshots?', $request->url());
            $this->assertSame('1', $request->header('X-NPL-Conditional')[0] ?? null);
            return Http::response(['ok' => true, 'data' => ['data' => [$this->snapshot(701), $this->snapshot(702)]]], 200, ['ETag' => 'W/"batch"']);
        });

        $result = app(SyncService::class)->refreshSessionSnapshots(7, [701, 702]);

        Http::assertSentCount(1);
        $this->assertSame(2, $result['seating']['sessions']);
        $this->assertDatabaseHas('mirror_game_sessions', ['session_id' => 999, 'venue_id' => 8]);
        $this->assertDatabaseHas('mirror_session_tables', ['session_id' => 702, 'player_npl_id' => 'PLAYER702']);
    }

    public function test_304_replays_a_complete_snapshot_without_restarting_running_timers(): void
    {
        $calls = 0;
        Http::fake(function ($request) use (&$calls) {
            if (++$calls > 1) {
                $this->assertSame('W/"batch"', $request->header('If-None-Match')[0] ?? null);
                return Http::response('', 304);
            }
            return Http::response(['ok' => true, 'data' => ['data' => [$this->snapshot(701)]]], 200, ['ETag' => 'W/"batch"']);
        });
        $sync = app(SyncService::class);
        $sync->refreshSessionSnapshots(7, [701]);
        $first = DB::table('mirror_session_tables')->where('session_id', 701)->first();
        // Simulate lost local application: cached bodies, unlike bare ETags,
        // must be able to rebuild the mirror after a 304.
        DB::table('mirror_session_tables')->where('session_id', 701)->delete();
        $second = $sync->refreshSessionSnapshots(7, [701]);
        $row = DB::table('mirror_session_tables')->where('session_id', 701)->first();
        $this->assertTrue($second['game_sessions']['not_modified']);
        $this->assertSame((int) $first->timer_synced_ms, (int) $row->timer_synced_ms);
        $this->assertSame(6000, MirrorTableTimer::elapsedMs($row, (int) $first->timer_synced_ms + 5000));
    }

    public function test_missing_metadata_does_not_remove_licensed_seating(): void
    {
        DB::table('mirror_game_sessions')->insert(['session_id' => 701, 'venue_id' => 7]);
        Http::fake(fn () => Http::response(['ok' => true, 'data' => ['data' => [$this->snapshot(701, 404)]]]));
        app(SyncService::class)->refreshSessionSnapshots(7, [701]);
        $this->assertDatabaseMissing('mirror_game_sessions', ['session_id' => 701]);
        $this->assertDatabaseHas('mirror_session_tables', ['session_id' => 701, 'player_npl_id' => 'PLAYER701']);
    }

    public function test_partial_batch_cannot_apply_some_sessions_or_erase_existing_rows(): void
    {
        DB::table('mirror_game_sessions')->insert(['session_id' => 701, 'venue_id' => 7, 'title' => 'Keep this']);
        Http::fake(fn () => Http::response(['ok' => true, 'data' => ['data' => [$this->snapshot(701)]]]));
        try {
            app(SyncService::class)->refreshSessionSnapshots(7, [701, 702]);
            $this->fail('A partial batch must be retried.');
        } catch (CloudException) {
            $this->assertDatabaseHas('mirror_game_sessions', ['session_id' => 701, 'title' => 'Keep this']);
            $this->assertDatabaseCount('mirror_session_tables', 0);
        }
    }

    public function test_mismatched_seating_identity_cannot_overwrite_another_session(): void
    {
        DB::table('mirror_game_sessions')->insert(['session_id' => 701, 'venue_id' => 7, 'title' => 'Keep this']);
        $row = $this->snapshot(701);
        $row['seating']['session_id'] = 702;
        Http::fake(fn () => Http::response(['ok' => true, 'data' => ['data' => [$row]]]));
        try {
            app(SyncService::class)->refreshSessionSnapshots(7, [701]);
            $this->fail('A seating snapshot from another session must be rejected.');
        } catch (CloudException) {
            $this->assertDatabaseHas('mirror_game_sessions', ['session_id' => 701, 'title' => 'Keep this']);
            $this->assertDatabaseCount('mirror_session_tables', 0);
        }
    }

    public function test_only_missing_batch_endpoint_falls_back_to_legacy_reads(): void
    {
        Http::fake(function ($request) {
            if (str_contains($request->url(), '/snapshots')) return Http::response(['ok' => false], 404);
            if (str_contains($request->url(), '/game-sessions')) return Http::response(['ok' => true, 'data' => ['data' => [$this->snapshot(701)['session']]]]);
            $this->assertStringContainsString('/internal/sessions/701/seating', $request->url());
            return Http::response(['ok' => true, 'data' => $this->snapshot(701)['seating']]);
        });
        app(SyncService::class)->refreshSessionSnapshots(7, [701]);
        Http::assertSentCount(3);
        $this->assertDatabaseHas('mirror_session_tables', ['session_id' => 701, 'player_npl_id' => 'PLAYER701']);
    }

    public function test_refused_batch_does_not_fall_back_to_another_endpoint(): void
    {
        Http::fake(fn () => Http::response(['ok' => false], 403));
        try {
            app(SyncService::class)->refreshSessionSnapshots(7, [701]);
            $this->fail('A refused licence must not use the public fallback.');
        } catch (CloudException $error) {
            $this->assertSame(403, $error->status);
            Http::assertSentCount(1);
        }
    }

    public function test_unsolicited_304_without_a_body_retries_unconditionally_once(): void
    {
        $calls = 0;
        Http::fake(function ($request) use (&$calls) {
            if (++$calls === 1) return Http::response('', 304);
            $this->assertFalse($request->hasHeader('If-None-Match'));
            $this->assertFalse($request->hasHeader('X-NPL-Conditional'));
            return Http::response(['ok' => true, 'data' => ['value' => 42]], 200, ['ETag' => 'W/"current"']);
        });
        $result = app(ConditionalCloudRead::class)->get('/api/v1/internal/desk-pulse', ['uid' => 'one']);
        $this->assertSame(42, $result['data']['value']);
        Http::assertSentCount(2);
    }

    public function test_query_and_language_do_not_share_private_representations(): void
    {
        Http::fake(function ($request) {
            $this->assertFalse($request->hasHeader('If-None-Match'));
            return Http::response(['ok' => true, 'data' => ['value' => 42]], 200, ['ETag' => 'W/"current"']);
        });
        $read = app(ConditionalCloudRead::class);
        $read->get('/api/v1/internal/desk-pulse', ['uid' => 'one']);
        $read->get('/api/v1/internal/desk-pulse', ['uid' => 'two']);
        app()->setLocale('zh');
        $read->get('/api/v1/internal/desk-pulse', ['uid' => 'one']);
        Http::assertSentCount(3);
    }

    public function test_an_error_cannot_be_replaced_by_cached_success_or_change_its_validator(): void
    {
        $calls = 0;
        Http::fake(function ($request) use (&$calls) {
            if (++$calls === 1) return Http::response(['ok' => true, 'data' => ['value' => 42]], 200, ['ETag' => 'W/"good"']);
            $this->assertSame('W/"good"', $request->header('If-None-Match')[0] ?? null);
            return $calls === 2 ? Http::response(['ok' => false], 503, ['ETag' => 'W/"bad"']) : Http::response('', 304);
        });
        $read = app(ConditionalCloudRead::class);
        $read->get('/api/v1/internal/desk-pulse', ['uid' => 'one']);
        try {
            $read->get('/api/v1/internal/desk-pulse', ['uid' => 'one']);
            $this->fail('A failed read must remain a failure.');
        } catch (CloudException $error) {
            $this->assertSame(503, $error->status);
        }
        $this->assertSame(42, $read->get('/api/v1/internal/desk-pulse', ['uid' => 'one'])['data']['value']);
    }
}
