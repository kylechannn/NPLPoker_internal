<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Tournament\TournamentBroadcaster;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Every request to the cloud rides a queue: offline it waits, online it
 * lands, reconnect resumes from exactly where it left off. These tests
 * cover the writes that used to be synchronous-or-lost.
 */
class QueueEverywhereTest extends TestCase
{
    use RefreshDatabase;

    private ?string $licenseDir = null;

    private function activateLicense(): void
    {
        $dir = sys_get_temp_dir().'/npl-queue-test-'.uniqid();
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

    private function tournament(): int
    {
        $result = app(TournamentService::class)->create([
            'name' => 'Queue Test Deepstack',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'starting_stack' => 20000,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 2,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
            ],
        ]);

        return (int) $result['session']['id'];
    }

    public function test_clock_broadcast_queues_offline_and_coalesces_to_one_row(): void
    {
        $this->activateLicense();
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $sessionId = $this->tournament();

        $this->assertTrue(app(TournamentBroadcaster::class)->publish($sessionId));
        $this->assertTrue(app(TournamentBroadcaster::class)->publish($sessionId));
        $this->assertTrue(app(TournamentBroadcaster::class)->publish($sessionId));

        Http::assertNothingSent();

        $rows = DB::table('cloud_call_queue')->where('group_key', 'clock:'.$sessionId)->get();
        $this->assertCount(1, $rows, 'clock states must coalesce — one live row per session, newest wins');
        $this->assertSame('pending', $rows[0]->status);
        $this->assertSame('/api/v1/internal/tournament/state', $rows[0]->path);
    }

    public function test_coalesced_row_is_rearmed_after_sent_not_duplicated(): void
    {
        $queue = app(CloudCallQueue::class);
        Http::fake(['*' => Http::response(['ok' => true, 'data' => []], 200)]);

        $first = $queue->enqueue('post', '/api/v1/internal/tournament/state', ['level' => 1], [
            'group' => 'clock:42', 'label' => 'Clock', 'coalesce' => true,
        ]);
        $this->assertSame('sent', DB::table('cloud_call_queue')->where('id', $first)->value('status'));

        $second = $queue->enqueue('post', '/api/v1/internal/tournament/state', ['level' => 2], [
            'group' => 'clock:42', 'label' => 'Clock', 'coalesce' => true,
        ]);

        $this->assertSame($first, $second, 'a sent coalesced row is re-armed in place');
        $this->assertSame(1, DB::table('cloud_call_queue')->where('group_key', 'clock:42')->count());
    }

    public function test_promote_queues_and_answers_instantly_offline(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $response = $this->postJson('/api/v1/desk/sessions/77/registrations/NPL123/promote');

        $response->assertOk();
        $this->assertTrue($response->json('data.result.queued'));
        Http::assertNothingSent();

        $job = DB::table('cloud_call_queue')->where('group_key', 'session:77')->first();
        $this->assertNotNull($job);
        $this->assertStringEndsWith('/registrations/NPL123/promote', $job->path);
        $this->assertSame(1, (int) $job->tolerate_missing);
    }

    public function test_create_table_queues_with_optimistic_seating_rows(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $sessionId = $this->tournament();
        DB::table('tournament_sessions')->where('id', $sessionId)->update(['game_session_id' => 501]);

        $response = $this->postJson('/api/v1/desk/'.$sessionId.'/tables', ['max_seats' => 6]);

        $response->assertOk();
        $this->assertTrue($response->json('data.table.queued'));
        $this->assertSame(1, $response->json('data.table.table_number'));

        // The optimistic table is on the mirror in the sync's own shape.
        $this->assertSame(6, DB::table('mirror_session_tables')
            ->where('session_id', 501)->where('table_number', 1)->count());

        $job = DB::table('cloud_call_queue')->where('group_key', 'session:501')->first();
        $this->assertNotNull($job);
        $this->assertSame('/api/v1/internal/sessions/501/tables', $job->path);
        Http::assertNothingSent();
    }

    public function test_membership_upsert_offline_is_visible_and_delete_cancels_queued_create(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $upsert = $this->postJson('/api/v1/membership', [
            'venue_id' => 7,
            'npl_id' => 'NPL777',
            'club_member_code' => 'CLUB-001',
        ]);

        $upsert->assertOk();
        $this->assertTrue($upsert->json('data.result.queued'));

        $row = DB::table('mirror_club_memberships')->where('venue_id', 7)->whereRaw("UPPER(npl_id) = 'NPL777'")->first();
        $this->assertNotNull($row, 'the register must show the new club ID immediately, offline included');
        $this->assertLessThan(0, (int) $row->cloud_id);
        $this->assertSame(1, DB::table('cloud_call_queue')->where('group_key', 'membership:7')->count());

        // Deleting the still-queued create cancels the queued write too —
        // otherwise reconnect would resurrect it.
        $delete = $this->deleteJson('/api/v1/membership/'.$row->cloud_id.'?venue_id=7');
        $delete->assertOk();
        $this->assertSame(0, DB::table('mirror_club_memberships')->where('venue_id', 7)->count());
        $this->assertSame(0, DB::table('cloud_call_queue')->where('group_key', 'membership:7')->where('status', 'pending')->count());
        Http::assertNothingSent();
    }

    public function test_player_update_queues_and_updates_roster_now(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        DB::table('mirror_players')->insert([
            'cloud_id' => 9001,
            'npl_id' => 'NPL500',
            'display_name' => 'Old Name',
            'status' => 'active',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $response = $this->postJson('/api/v1/players/update', [
            'npl_id' => 'NPL500',
            'display_name' => 'New Name',
            'first_name' => 'New',
        ]);

        $response->assertOk();
        $this->assertTrue($response->json('data.result.queued'));
        $this->assertSame('New Name', DB::table('mirror_players')->where('npl_id', 'NPL500')->value('display_name'));
        $this->assertSame(1, DB::table('cloud_call_queue')->where('group_key', 'player:NPL500')->count());
        Http::assertNothingSent();
    }

    public function test_password_validates_locally_and_scrubs_payload_after_send(): void
    {
        // Format failures refuse HERE — they must never dead-letter.
        $bad = $this->postJson('/api/v1/players/password', [
            'npl_id' => 'NPL500',
            'password' => 'short',
            'password_confirmation' => 'short',
        ]);
        $bad->assertStatus(422);

        Http::fake(['*' => Http::response(['ok' => true, 'data' => []], 200)]);

        $good = $this->postJson('/api/v1/players/password', [
            'npl_id' => 'NPL500',
            'password' => 'Sup3rSecret42',
            'password_confirmation' => 'Sup3rSecret42',
        ]);
        $good->assertOk();

        $job = DB::table('cloud_call_queue')->where('group_key', 'player:NPL500')->first();
        $this->assertNotNull($job);
        $this->assertSame('sent', $job->status);
        $this->assertNull($job->payload, 'a delivered password must not linger in the queue table');
    }

    protected function tearDown(): void
    {
        if ($this->licenseDir !== null) {
            putenv('NPL_INTERNAL_DATA_DIR');
            unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
            @unlink($this->licenseDir.'/license.json');
            @rmdir($this->licenseDir);
            $this->licenseDir = null;
        }
        Cache::flush();

        parent::tearDown();
    }
}
