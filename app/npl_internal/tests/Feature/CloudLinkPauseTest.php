<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Sync\OutboxService;
use App\Services\Tournament\TournamentBroadcaster;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Offline resilience: a lost connection PAUSES the cloud queues — no retry
 * budget burned, no operator stall — and the /up probe releases everything
 * the moment the link returns. A weekend outage must never dead-letter a
 * paid buy-in.
 */
class CloudLinkPauseTest extends TestCase
{
    use RefreshDatabase;

    private function outboxRow(array $overrides = []): int
    {
        return (int) DB::table('sync_outbox')->insertGetId(array_merge([
            'entity_type' => 'jackpot_entry',
            'operation' => 'create',
            'idempotency_key' => substr(hash('sha256', uniqid('', true)), 0, 40),
            'payload' => json_encode(['npl_id' => 'NPL123']),
            'status' => 'pending',
            'attempts' => 0,
            'available_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ], $overrides));
    }

    private function queueRow(array $overrides = []): int
    {
        return (int) DB::table('cloud_call_queue')->insertGetId(array_merge([
            'group_key' => 'session:9',
            'label' => 'Remove NPL123 — session #9',
            'method' => 'delete',
            'path' => '/api/v1/internal/sessions/9/registrations/NPL123',
            'payload' => null,
            'idempotency_key' => null,
            'tolerate_missing' => false,
            'status' => 'pending',
            'attempts' => 0,
            'available_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ], $overrides));
    }

    public function test_outbox_connection_failure_pauses_without_burning_attempts(): void
    {
        Http::fake(fn () => throw new ConnectionException('Connection refused'));

        $id = $this->outboxRow();

        $result = app(OutboxService::class)->drain();

        $row = DB::table('sync_outbox')->where('id', $id)->first();
        $this->assertSame('pending', $row->status);
        $this->assertSame(0, (int) $row->attempts, 'offline must never burn retry budget');
        $this->assertSame(0, $result['sent']);
        $this->assertTrue(app(CloudLinkState::class)->isOffline());
    }

    public function test_paused_outbox_makes_no_dials_while_offline(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $id = $this->outboxRow();

        app(OutboxService::class)->drain();

        Http::assertNothingSent();
        $row = DB::table('sync_outbox')->where('id', $id)->first();
        $this->assertSame('pending', $row->status);
        $this->assertSame(0, (int) $row->attempts);
    }

    public function test_probe_recovers_link_and_drains_backlog(): void
    {
        app(CloudLinkState::class)->markOffline();

        // Leftover backoff from before the outage — recovery must not wait it out.
        $id = $this->outboxRow(['available_at' => now()->addMinutes(45), 'attempts' => 3]);

        Http::fake([
            '*/up' => Http::response('ok', 200),
            '*' => Http::response(['ok' => true, 'data' => ['result' => ['applied' => true]]], 200),
        ]);

        // The probe is rate-limited; move past the interval markOffline stamped.
        $this->travel(20)->seconds();

        $result = app(OutboxService::class)->drain();

        $this->assertFalse(app(CloudLinkState::class)->isOffline());
        $this->assertSame(1, $result['sent']);
        $this->assertSame('sent', DB::table('sync_outbox')->where('id', $id)->value('status'));
    }

    public function test_probe_failure_keeps_queue_paused(): void
    {
        app(CloudLinkState::class)->markOffline();

        $id = $this->outboxRow();

        Http::fake(fn () => throw new ConnectionException('still down'));

        $this->travel(20)->seconds();

        $result = app(OutboxService::class)->drain();

        $this->assertTrue(app(CloudLinkState::class)->isOffline());
        $this->assertSame(0, $result['sent']);
        // The probe failed, so the entry itself was never dialed: still
        // pending at zero attempts, waiting for the link.
        $row = DB::table('sync_outbox')->where('id', $id)->first();
        $this->assertSame('pending', $row->status);
        $this->assertSame(0, (int) $row->attempts);
    }

    public function test_call_queue_connection_failure_pauses_without_burning_attempts(): void
    {
        Http::fake(fn () => throw new ConnectionException('Connection refused'));

        $id = $this->queueRow();

        app(CloudCallQueue::class)->drain();

        $row = DB::table('cloud_call_queue')->where('id', $id)->first();
        $this->assertSame('pending', $row->status);
        $this->assertSame(0, (int) $row->attempts, 'offline must never burn retry budget');
        $this->assertTrue(app(CloudLinkState::class)->isOffline());
    }

    public function test_enqueue_answers_instantly_while_offline(): void
    {
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        app(CloudCallQueue::class)->enqueue('post', '/api/v1/internal/sessions/9/tables/2/stop-countdown', [], [
            'group' => 'session:9',
            'label' => 'Stop countdown, table 2 — session #9',
        ]);

        // No inline drain, no probe, no dial — the operator's action must
        // never wait on a dead link.
        Http::assertNothingSent();
        $this->assertSame(1, DB::table('cloud_call_queue')->where('status', 'pending')->count());
    }

    public function test_recovery_releases_parked_backoff_in_both_queues(): void
    {
        $outboxId = $this->outboxRow(['available_at' => now()->addMinutes(50)]);
        $queueId = $this->queueRow(['available_at' => now()->addMinutes(50)]);

        $link = app(CloudLinkState::class);
        $link->markOffline();
        $link->markOnline();

        $this->assertFalse(\Carbon\CarbonImmutable::parse(DB::table('sync_outbox')->where('id', $outboxId)->value('available_at'))->isFuture());
        $this->assertFalse(\Carbon\CarbonImmutable::parse(DB::table('cloud_call_queue')->where('id', $queueId)->value('available_at'))->isFuture());
    }

    public function test_broadcaster_skips_silently_while_offline(): void
    {
        // LicenseKeyProvider is final — feed it a real lease file instead
        // of a mock, through the same env override the Go host uses.
        $dir = sys_get_temp_dir().'/npl-link-test-'.uniqid();
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

        try {
            app(CloudLinkState::class)->markOffline();
            Http::fake();

            $result = app(TournamentBroadcaster::class)->publish(1);

            $this->assertFalse($result);
            Http::assertNothingSent();
        } finally {
            putenv('NPL_INTERNAL_DATA_DIR');
            unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
            app(LicenseKeyProvider::class)->forget();
            @unlink($dir.'/license.json');
            @rmdir($dir);
        }
    }

    public function test_status_endpoint_reports_link_state(): void
    {
        Http::fake();
        app(CloudLinkState::class)->markOffline();

        $response = $this->getJson('/api/v1/cloud-queue/status');

        $response->assertOk();
        $this->assertSame('offline', $response->json('data.link.state'));
        $this->assertNotNull($response->json('data.link.offline_since'));
    }

    protected function tearDown(): void
    {
        Cache::flush();

        parent::tearDown();
    }
}
