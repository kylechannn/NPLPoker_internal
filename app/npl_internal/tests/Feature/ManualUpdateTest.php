<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudException;
use App\Services\Sync\ManualUpdateRunner;
use App\Services\Sync\SyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class ManualUpdateTest extends TestCase
{
    use RefreshDatabase;

    private string $dataDir;

    protected function setUp(): void
    {
        parent::setUp();

        // Write a real licence lease so the genuine LicenseKeyProvider path
        // is exercised rather than a stubbed one.
        $this->dataDir = sys_get_temp_dir().'/npl-internal-test-'.uniqid();
        mkdir($this->dataDir, 0o777, true);
        file_put_contents($this->dataDir.'/license.json', json_encode([
            'key' => 'NPL-TEST-TEST-TEST',
            'device_id' => 'NPLI-TEST',
            'lease' => ['lease_until' => now()->addDays(7)->toIso8601String()],
        ]));
        putenv('NPL_INTERNAL_DATA_DIR='.$this->dataDir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $this->dataDir;

        config(['nplcloud.media.disk_path' => $this->dataDir.'/media']);
    }

    protected function tearDown(): void
    {
        @unlink($this->dataDir.'/license.json');
        @rmdir($this->dataDir);
        putenv('NPL_INTERNAL_DATA_DIR');
        unset($_ENV['NPL_INTERNAL_DATA_DIR']);

        parent::tearDown();
    }

    /** @var array{venues: array, sessions: array, seating: array} */
    private array $cloudState = ['venues' => [], 'sessions' => [], 'seating' => ['tables' => []]];

    private bool $cloudRegistered = false;

    /**
     * Http::fake() APPENDS stubs and the first match wins, so re-faking mid
     * test silently keeps the old response. One closure over mutable state
     * lets a test change what the cloud returns partway through.
     */
    private function fakeCloud(array $venues, array $sessions, array $seating = ['tables' => []]): void
    {
        $this->cloudState = ['venues' => $venues, 'sessions' => $sessions, 'seating' => $seating];

        if ($this->cloudRegistered) {
            return;
        }
        $this->cloudRegistered = true;

        Http::fake(function ($request) {
            $url = $request->url();

            if (str_contains($url, '/seating')) {
                return Http::response(['ok' => true, 'data' => $this->cloudState['seating']], 200);
            }
            if (str_contains($url, '/api/v1/venues')) {
                return Http::response(['ok' => true, 'data' => ['data' => $this->cloudState['venues']]], 200);
            }
            if (str_contains($url, '/api/v1/game-sessions')) {
                return Http::response(['ok' => true, 'data' => ['data' => $this->cloudState['sessions']]], 200);
            }

            return Http::response(['ok' => true, 'data' => []], 200);
        });
    }

    public function test_manual_update_mirrors_cloud_data_and_reports_derived_progress(): void
    {
        $this->fakeCloud(
            venues: [['id' => 7, 'venue_name' => 'Rockdale RSL', 'state_code' => 'NSW']],
            sessions: [[
                'session_id' => 91, 'title' => 'Nightly NLH', 'category' => 'cash_game',
                'venue_id' => 7, 'venue_name' => 'Rockdale RSL', 'session_date' => '2026-07-28',
                'start_time' => '19:00', 'status' => 'scheduled', 'registrations_count' => 3,
                'is_open_for_registration' => true,
            ]],
            seating: ['tables' => [[
                'table_number' => 1, 'status' => 'active', 'max_seats' => 8,
                'seats' => [
                    ['seat_number' => 1, 'player' => ['npl_id' => 'ACE2026', 'display_name' => 'Ace Nguyen']],
                    ['seat_number' => 2, 'player' => null],
                ],
                'waitlist' => [['position' => 1, 'player' => ['npl_id' => 'BOB2026', 'display_name' => 'Bob Wong']]],
            ]]],
        );

        $run = app(ManualUpdateRunner::class)->start('phpunit');

        $this->assertSame('succeeded', $run['status']);
        $this->assertSame(100, $run['progress']);
        $this->assertSame(1, DB::table('mirror_venues')->count());
        $this->assertSame(1, DB::table('mirror_game_sessions')->count());

        // Seats + wait list are flattened into one queryable table.
        $this->assertSame(3, DB::table('mirror_session_tables')->count());
        $this->assertSame('Ace Nguyen', DB::table('mirror_session_tables')->where('seat_number', 1)->value('player_display_name'));
        $this->assertSame('waitlisted', DB::table('mirror_session_tables')->whereNotNull('waitlist_position')->value('registration_status'));

        // Staging is always drained after a successful swap.
        $this->assertSame(0, DB::table('mirror_venues_staging')->count());

        // Per-entity resume state is recorded independently.
        $this->assertSame('ok', DB::table('sync_entity_states')->where('entity', 'venues')->value('status'));
    }

    public function test_an_empty_cloud_payload_never_wipes_populated_local_tables(): void
    {
        $this->fakeCloud(
            venues: [['id' => 7, 'venue_name' => 'Rockdale RSL']],
            sessions: [],
        );
        app(ManualUpdateRunner::class)->start('seed');
        $this->assertSame(1, DB::table('mirror_venues')->count());

        // The cloud now answers with nothing — a truncated response, not a
        // genuinely emptied venue list.
        $this->fakeCloud(venues: [], sessions: []);

        $this->expectException(CloudException::class);
        app(SyncService::class)->syncEntity('venues');
    }

    public function test_a_failing_entity_degrades_the_run_to_partial_without_losing_the_others(): void
    {
        Http::fake([
            '*/api/v1/venues*' => Http::response(['ok' => true, 'data' => ['data' => [
                ['id' => 7, 'venue_name' => 'Rockdale RSL'],
            ]]], 200),
            '*/api/v1/game-sessions*' => Http::response('boom', 500),
        ]);

        $run = app(ManualUpdateRunner::class)->start('partial');

        $this->assertSame('partial', $run['status']);
        $this->assertSame(1, DB::table('mirror_venues')->count());
        $this->assertSame('failed', $run['summary']['entities']['game_sessions']['status']);
        $this->assertSame('ok', $run['summary']['entities']['venues']['status']);
    }

    public function test_unchanged_data_is_skipped_via_etag(): void
    {
        Http::fake([
            '*/api/v1/venues*' => Http::response('', 304),
            '*/api/v1/game-sessions*' => Http::response(['ok' => true, 'data' => ['data' => []]], 200),
        ]);

        DB::table('sync_entity_states')->insert([
            'entity' => 'venues', 'status' => 'ok', 'etag' => 'W/"abc"', 'row_count' => 5,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        $result = app(SyncService::class)->syncEntity('venues');

        $this->assertTrue($result['not_modified']);
        $this->assertSame(5, $result['rows']);
    }

    public function test_the_manifest_endpoint_is_the_shared_source_of_truth(): void
    {
        $response = $this->getJson('/api/v1/sync/manifest')->assertOk();

        $entities = array_column($response->json('data.entities'), 'entity');

        // game_sessions must precede seating — dependency order.
        $this->assertSame(['venues', 'game_sessions', 'seating'], $entities);
        $this->assertTrue($response->json('data.activated'));
    }

    public function test_run_endpoint_returns_202_with_a_run_id_rather_than_blocking(): void
    {
        $this->fakeCloud(venues: [['id' => 1, 'venue_name' => 'V']], sessions: []);

        $this->postJson('/api/v1/sync/run', ['trigger_source' => 'ui'])
            ->assertStatus(202)
            ->assertJsonPath('ok', true)
            ->assertJsonPath('data.run.status', 'succeeded');
    }
}
