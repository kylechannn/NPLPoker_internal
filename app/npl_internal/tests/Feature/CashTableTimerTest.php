<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Sync\SyncService;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use App\Support\MirrorTableTimer;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The director's stopwatch on each cash table, from the desk: the cloud is
 * the only clock; the mirror keeps its report as relative milliseconds so
 * the desk counts on between reports; a press repaints the mirror at once
 * and rides the queue to the cloud stamped with WHEN it was made.
 */
class CashTableTimerTest extends TestCase
{
    use RefreshDatabase;

    private ?string $licenseDir = null;

    protected function tearDown(): void
    {
        if ($this->licenseDir !== null) {
            @unlink($this->licenseDir.'/license.json');
            @rmdir($this->licenseDir);
            putenv('NPL_INTERNAL_DATA_DIR');
            unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
        }

        parent::tearDown();
    }

    private function activateLicense(): void
    {
        $dir = sys_get_temp_dir().'/npl-timer-test-'.uniqid();
        mkdir($dir, 0o755, true);
        file_put_contents($dir.'/license.json', json_encode([
            'key' => 'NPL-TEST',
            'device_id' => 'device-test',
            'lease' => ['lease_until' => '2030-01-01T00:00:00+00:00'],
        ]));
        putenv('NPL_INTERNAL_DATA_DIR='.$dir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $dir;
        $_SERVER['NPL_INTERNAL_DATA_DIR'] = $dir;
        app(LicenseKeyProvider::class)->forget();
        $this->licenseDir = $dir;
    }

    private function linkedCashDesk(): int
    {
        $result = app(TournamentService::class)->create([
            'name' => 'Timer Cash',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'game_type' => 'cash',
            'starting_stack' => 20000,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 2,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
            ],
        ]);
        $id = (int) $result['session']['id'];
        DB::table('tournament_sessions')->where('id', $id)->update(['game_session_id' => 501]);

        return $id;
    }

    /** @param array<string, mixed> $overrides table-level mirror columns */
    private function mirrorTable(int $tableNumber, array $overrides = []): void
    {
        foreach (range(1, 2) as $seat) {
            DB::table('mirror_session_tables')->insert($overrides + [
                'session_table_key' => "501:{$tableNumber}:{$seat}",
                'session_id' => 501,
                'table_number' => $tableNumber,
                'seat_number' => $seat,
                'table_status' => 'open',
                'table_phase' => 'open',
                'max_seats' => 8,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }
    }

    /** @return array<string, mixed> */
    private function deskTable(int $desk, int $tableNumber): array
    {
        return collect(app(TournamentDeskService::class)->seating($desk)['tables'])->firstWhere('table_number', $tableNumber);
    }

    private function press(string $action, int $tableNumber = 1): \Illuminate\Testing\TestResponse
    {
        return $this->postJson("/api/v1/desk/sessions/501/tables/{$tableNumber}/timer", ['action' => $action]);
    }

    public function test_the_mirror_counts_on_from_the_clouds_last_report(): void
    {
        $now = MirrorTableTimer::nowMs();
        $running = (object) ['timer_running' => 1, 'timer_elapsed_ms' => 90_000, 'timer_synced_ms' => $now - 4_000];
        $paused = (object) ['timer_running' => 0, 'timer_elapsed_ms' => 5_000, 'timer_synced_ms' => $now - 60_000];
        $never = (object) ['timer_running' => null, 'timer_elapsed_ms' => null, 'timer_synced_ms' => null];

        $this->assertSame(94_000, MirrorTableTimer::elapsedMs($running, $now), 'a running stopwatch keeps counting between reports');
        $this->assertSame(5_000, MirrorTableTimer::elapsedMs($paused, $now), 'a paused one stays frozen');
        $this->assertNull(MirrorTableTimer::elapsedMs($never, $now));
        $this->assertNull(MirrorTableTimer::elapsedMs(null, $now));
        $this->assertTrue(MirrorTableTimer::running($running));
        $this->assertFalse(MirrorTableTimer::running($paused));
        $this->assertTrue(MirrorTableTimer::started($paused));
        $this->assertFalse(MirrorTableTimer::started($never));

        // A report is read as relative ms; a payload without one clears the columns.
        $this->assertSame(
            ['timer_running' => false, 'timer_elapsed_ms' => 12_000, 'timer_synced_ms' => 777],
            MirrorTableTimer::columnsFromCloud(['live_elapsed_ms' => 12_000, 'timer_running' => false], 777),
        );
        $this->assertSame(MirrorTableTimer::cleared(), MirrorTableTimer::columnsFromCloud(['live_elapsed_ms' => null]));
    }

    public function test_the_seat_map_pull_stores_each_tables_stopwatch(): void
    {
        $this->activateLicense();
        Http::fake(['*/seating' => Http::response(['ok' => true, 'data' => ['tables' => [
            [
                'table_number' => 1, 'status' => 'active', 'phase' => 'live', 'max_seats' => 8,
                'live_elapsed_ms' => 90_000, 'timer_running' => true,
                'seats' => [['seat_number' => 1, 'player' => null]], 'waitlist' => [['position' => 1, 'player' => ['npl_id' => 'BOB', 'display_name' => 'Bob']]],
            ],
            [
                'table_number' => 2, 'status' => 'active', 'phase' => 'live', 'max_seats' => 8,
                'live_elapsed_ms' => 5_000, 'timer_running' => false,
                'seats' => [['seat_number' => 1, 'player' => null]], 'waitlist' => [],
            ],
            [
                'table_number' => 3, 'status' => 'open', 'phase' => 'open', 'max_seats' => 8,
                'live_elapsed_ms' => null, 'timer_running' => null,
                'seats' => [['seat_number' => 1, 'player' => null]], 'waitlist' => [],
            ],
        ]]], 200)]);

        app(SyncService::class)->refreshSeatingFor(null, [501]);

        $running = DB::table('mirror_session_tables')->where('session_id', 501)->where('table_number', 1)->get();
        $this->assertGreaterThan(0, $running->count());
        foreach ($running as $row) {
            // The seat rows AND the wait-list row of the table all carry it.
            $this->assertSame(1, (int) $row->timer_running);
            $this->assertSame(90_000, (int) $row->timer_elapsed_ms);
            $this->assertEqualsWithDelta(MirrorTableTimer::nowMs(), (int) $row->timer_synced_ms, 5_000);
        }
        $paused = DB::table('mirror_session_tables')->where('table_number', 2)->first();
        $this->assertSame(0, (int) $paused->timer_running);
        $this->assertSame(5_000, (int) $paused->timer_elapsed_ms);
        $idle = DB::table('mirror_session_tables')->where('table_number', 3)->first();
        $this->assertNull($idle->timer_elapsed_ms);
        $this->assertNull($idle->timer_running);

        // …and the desk's seating reads them back as relative ms.
        $desk = $this->linkedCashDesk();
        $one = $this->deskTable($desk, 1);
        $this->assertTrue($one['timer_running']);
        $this->assertEqualsWithDelta(90_000, $one['timer_elapsed_ms'], 5_000);
        $two = $this->deskTable($desk, 2);
        $this->assertFalse($two['timer_running']);
        $this->assertSame(5_000, $two['timer_elapsed_ms']);
        $three = $this->deskTable($desk, 3);
        $this->assertNull($three['timer_running']);
        $this->assertNull($three['timer_elapsed_ms']);
    }

    public function test_start_pause_and_resume_repaint_the_mirror_and_ride_the_queue(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();
        $desk = $this->linkedCashDesk();
        $this->mirrorTable(1);

        // START: the table goes live and counts from zero, at once.
        $this->press('start')->assertOk()->assertJsonPath('data.result.queued', true)->assertJsonPath('data.result.action', 'start');
        $table = $this->deskTable($desk, 1);
        $this->assertSame('live', $table['table_phase']);
        $this->assertSame('active', $table['table_status']);
        $this->assertTrue($table['timer_running']);
        $this->assertEqualsWithDelta(0, $table['timer_elapsed_ms'], 2_000);

        // A second start changes nothing (already counting).
        $before = DB::table('mirror_session_tables')->where('table_number', 1)->value('timer_synced_ms');
        $this->press('start')->assertOk();
        $this->assertSame($before, DB::table('mirror_session_tables')->where('table_number', 1)->value('timer_synced_ms'));

        // Pretend 90 seconds went by, then PAUSE: it freezes at what it had counted.
        DB::table('mirror_session_tables')->where('table_number', 1)->update([
            'timer_elapsed_ms' => 0,
            'timer_synced_ms' => MirrorTableTimer::nowMs() - 90_000,
        ]);
        $this->press('pause')->assertOk()->assertJsonPath('data.result.action', 'pause');
        $table = $this->deskTable($desk, 1);
        $this->assertFalse($table['timer_running']);
        $this->assertEqualsWithDelta(90_000, $table['timer_elapsed_ms'], 2_000);
        $frozen = $table['timer_elapsed_ms'];

        // RESUME: counts on from the banked time, the table stays live.
        $this->press('start')->assertOk();
        $table = $this->deskTable($desk, 1);
        $this->assertTrue($table['timer_running']);
        $this->assertSame('live', $table['table_phase']);
        $this->assertEqualsWithDelta($frozen, $table['timer_elapsed_ms'], 2_000);

        // Every press queued a cloud call, in order, stamped with the moment it was made.
        $jobs = DB::table('cloud_call_queue')->where('group_key', 'session:501')->orderBy('id')->get();
        $this->assertSame(['start', 'start', 'pause', 'start'], $jobs->map(fn ($job) => json_decode($job->payload, true)['action'])->all());
        foreach ($jobs as $job) {
            $this->assertSame('post', $job->method);
            $this->assertSame('/api/v1/internal/sessions/501/tables/1/timer', $job->path);
            $this->assertMatchesRegularExpression(
                '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/',
                json_decode($job->payload, true)['at'],
                'the press time carries milliseconds and an offset',
            );
        }
        Http::assertNothingSent();
    }

    public function test_pressing_start_on_a_table_that_is_already_live_but_idle_starts_its_count(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();
        $desk = $this->linkedCashDesk();
        // Live by the session clock, the director has not started its stopwatch.
        $this->mirrorTable(1, ['table_status' => 'active', 'table_phase' => 'live']);
        $this->assertNull($this->deskTable($desk, 1)['timer_elapsed_ms']);

        $this->press('start')->assertOk();

        $table = $this->deskTable($desk, 1);
        $this->assertTrue($table['timer_running']);
        $this->assertEqualsWithDelta(0, $table['timer_elapsed_ms'], 2_000);
    }

    public function test_open_and_close_reset_the_stopwatch_and_live_restarts_it(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();
        $desk = $this->linkedCashDesk();
        $this->mirrorTable(1);
        $this->press('start')->assertOk();
        $this->assertTrue($this->deskTable($desk, 1)['timer_running']);

        $this->postJson('/api/v1/desk/sessions/501/tables/1/state', ['state' => 'open'])->assertOk();
        $table = $this->deskTable($desk, 1);
        $this->assertNull($table['timer_running']);
        $this->assertNull($table['timer_elapsed_ms']);

        // The LIVE switch (older desks, admin phone) starts the count too.
        $this->postJson('/api/v1/desk/sessions/501/tables/1/state', ['state' => 'live'])->assertOk();
        $table = $this->deskTable($desk, 1);
        $this->assertTrue($table['timer_running']);
        $this->assertEqualsWithDelta(0, $table['timer_elapsed_ms'], 2_000);

        $this->postJson('/api/v1/desk/sessions/501/tables/1/state', ['state' => 'closed'])->assertOk();
        $this->assertNull($this->deskTable($desk, 1)['timer_elapsed_ms']);
    }

    public function test_a_closed_or_unknown_table_and_a_bad_action_are_refused(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();
        $this->linkedCashDesk();
        $this->mirrorTable(1, ['table_status' => 'closed', 'table_phase' => 'closed']);

        $this->press('start')->assertStatus(422)->assertJsonPath('error.code', 'TABLE_CLOSED');
        $this->press('sideways')->assertStatus(422)->assertJsonPath('error.code', 'INVALID_ACTION');
        $this->press('start', 9)->assertStatus(404)->assertJsonPath('error.code', 'UNKNOWN_TABLE');
        $this->assertSame(0, DB::table('cloud_call_queue')->count(), 'a refused press never reaches the cloud');
    }
}
