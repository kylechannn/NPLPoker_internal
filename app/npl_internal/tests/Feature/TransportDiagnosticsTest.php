<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\TransportMetrics;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class TransportDiagnosticsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Http::preventStrayRequests();
        // RefreshDatabase preserves only the main in-memory connection.
        (require database_path('migrations/2026_10_02_000200_create_transport_metric_buckets.php'))->up();
        DB::connection('cache')->table('transport_metric_buckets')->delete();
    }

    public function test_real_cloud_client_records_304_errors_and_offline_skips_without_sensitive_fields(): void
    {
        Http::fakeSequence()->push(['ok' => true, 'data' => ['npl_id' => 'PRIVATE-PLAYER']], 200)
            ->push('', 304)->push(['ok' => false, 'message' => 'PRIVATE-ERROR'], 503);
        $client = app(CloudClient::class);
        $path = '/api/v1/internal/sessions/76543/seating';
        $client->getJson($path);
        $this->assertTrue($client->getJson($path, [], 'W/"private"', true)['not_modified']);
        try {
            $client->getJson($path);
            $this->fail('503 still fails');
        } catch (CloudException $e) {
            $this->assertSame(503, $e->status);
        }
        app(CloudLinkState::class)->markOffline();
        try {
            $client->getJson($path);
            $this->fail('Offline still skips');
        } catch (CloudException $e) {
            $this->assertSame(CloudException::UNREACHABLE, $e->errorCode);
        }
        $metrics = app(TransportMetrics::class)->snapshot();
        $row = collect($metrics['families'])->firstWhere('family', 'seating');
        $this->assertSame(4, $row['requests']);
        $this->assertSame(3, $row['attempts']);
        $this->assertSame(1, $row['not_modified']);
        $this->assertSame(2, $row['errors']);
        $this->assertSame(1, $row['skipped']);
        $this->assertSame(4, array_sum($row['duration_buckets']));
        $json = json_encode($metrics);
        foreach (['PRIVATE', '76543', 'W/"private"', '/api/', 'token', 'payload'] as $secret) {
            $this->assertStringNotContainsString($secret, $json);
        }
        Http::assertSentCount(3);
    }

    public function test_missing_diagnostic_storage_preserves_writes_errors_and_status_endpoint(): void
    {
        Schema::connection('cache')->drop('transport_metric_buckets');
        Http::fakeSequence()->push(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'applied']]])->push(['ok' => false], 503);
        $client = app(CloudClient::class);
        $result = $client->postJson('/api/v1/internal/desk-sessions/7/cash-table-moves/51/ack', ['status' => 'applied']);
        $this->assertSame('applied', $result['move']['status']);
        try {
            $client->postJson('/api/v1/internal/outbox', []);
            $this->fail('Original 503 must propagate');
        } catch (CloudException $e) {
            $this->assertSame(503, $e->status);
        }
        $this->getJson('/api/v1/cloud-queue/status')->assertOk()->assertJsonPath('data.transport.available', false)
            ->assertJsonPath('data.transport.backlog.cash_ack_pending', 0);
        Http::assertSentCount(2);
    }

    public function test_status_reports_only_unconfirmed_cash_moves_without_exporting_their_identity(): void
    {
        $this->freezeTime();
        foreach (['applied_pending', 'failed_pending', 'completed'] as $index => $state) {
            DB::table('cash_table_moves')->insert(['id' => $index + 1, 'tournament_session_id' => 111,
                'player_npl_id' => 'PRIVATE-PLAYER', 'status' => $state, 'payload' => '{"secret":"PRIVATE"}',
                'reason' => 'PRIVATE-ERROR', 'created_at' => now()->subSeconds(120 - $index * 10), 'updated_at' => now()]);
        }
        $response = $this->getJson('/api/v1/cloud-queue/status')->assertOk()
            ->assertJsonPath('data.transport.backlog.cash_ack_pending', 2)
            ->assertJsonPath('data.transport.backlog.cash_ack_oldest_age_seconds', 120);
        $this->assertStringNotContainsString('PRIVATE', json_encode($response->json('data.transport')));
        $this->assertDatabaseCount('cash_table_moves', 3);
        $this->assertDatabaseHas('cash_table_moves', ['id' => 1, 'status' => 'applied_pending']);
        Http::assertNothingSent();
    }

    public function test_minute_aggregation_bounds_retention_families_and_histograms_under_load(): void
    {
        $metrics = app(TransportMetrics::class);
        $this->freezeTime();
        foreach (range(0, 64) as $minute) {
            foreach (TransportMetrics::FAMILIES as $family) {
                $metrics->record($family, 200, 100, 5, 1, false);
            }
            $this->travel(1)->minutes();
        }
        foreach ([100, 101, 300, 301, 1000, 1001, 3000, 3001, 10000, 10001] as $ms) {
            $metrics->record('session_batch', 200, $ms, 0, 1, false);
        }
        for ($i = 0; $i < 1000; $i++) {
            $metrics->record('arbitrary-secret-'.$i, 200, 1, 0, 1, false);
        }
        $this->assertLessThanOrEqual(60 * count(TransportMetrics::FAMILIES), DB::connection('cache')->table('transport_metric_buckets')->count());
        $row = collect($metrics->snapshot()['families'])->firstWhere('family', 'session_batch');
        $this->assertSame([60, 2, 2, 2, 2, 1], $row['duration_buckets']);
        $this->assertSame(10001, $row['duration_max_ms']);
        $this->assertSame(1059, collect($metrics->snapshot()['families'])->firstWhere('family', 'other')['requests']);
        $this->travel(61)->minutes();
        $this->assertSame([], $metrics->snapshot()['families']);
    }

    public function test_file_storage_survives_connection_restart_and_busy_storage_never_delays_an_ack(): void
    {
        $file = tempnam(sys_get_temp_dir(), 'npl-transport-');
        config(['database.connections.cache.database' => $file, 'database.connections.transport.database' => $file]);
        DB::purge('cache');
        DB::purge('transport');
        $lock = null;
        try {
            (require database_path('migrations/2026_10_02_000200_create_transport_metric_buckets.php'))->up();
            $metrics = app(TransportMetrics::class);
            $metrics->record('cash_ack', 200, 42, 12, 1, false);
            DB::purge('transport');
            $this->assertSame(1, $metrics->snapshot()['families'][0]['requests']);
            $lock = new \PDO('sqlite:'.$file);
            $lock->exec('BEGIN IMMEDIATE');
            Http::fake(fn () => Http::response(['ok' => true, 'data' => ['move' => ['id' => 51, 'status' => 'applied']]]));
            $started = hrtime(true);
            $result = app(CloudClient::class)->postJson('/api/v1/internal/desk-sessions/7/cash-table-moves/51/ack', ['status' => 'applied']);
            $this->assertLessThan(500, (hrtime(true) - $started) / 1000000, 'Diagnostics must not wait for a busy SQLite writer');
            $this->assertSame('applied', $result['move']['status']);
            $lock->exec('ROLLBACK');
            $lock = null;
            $this->assertSame(1, $metrics->snapshot()['families'][0]['requests'], 'The busy sample is dropped, not queued ahead of business writes');
        } finally {
            if ($lock) {
                $lock->exec('ROLLBACK');
            }
            $lock = null;
            DB::purge('transport');
            DB::purge('cache');
            foreach ([$file, $file.'-wal', $file.'-shm'] as $path) {
                if (is_file($path)) {
                    unlink($path);
                }
            }
        }
    }

    public function test_migration_indexes_main_cash_journal_and_recovers_partial_application_without_changing_records(): void
    {
        $migration = require database_path('migrations/2026_10_02_000200_create_transport_metric_buckets.php');
        DB::table('cash_table_moves')->insert(['id' => 51, 'tournament_session_id' => 7,
            'player_npl_id' => 'TEST', 'status' => 'applied_pending', 'payload' => '{}', 'created_at' => now(), 'updated_at' => now()]);
        $this->assertTrue(Schema::hasIndex('cash_table_moves', ['status', 'created_at']));
        $this->assertFalse(Schema::hasTable('transport_metric_buckets'));
        $this->assertFalse(Schema::connection('cache')->hasTable('cash_table_moves'));
        $this->assertTrue(Schema::connection('cache')->hasTable('transport_metric_buckets'));

        Schema::table('cash_table_moves', fn ($table) => $table->dropIndex('cash_moves_status_created'));
        $migration->up(); // Existing cache table must not skip the missing main index.
        $migration->up(); // A repeated attempt must be safe on both connections.
        $this->assertTrue(Schema::hasIndex('cash_table_moves', 'cash_moves_status_created'));
        $migration->down();
        $migration->down();
        $this->assertFalse(Schema::hasIndex('cash_table_moves', 'cash_moves_status_created'));
        $this->assertFalse(Schema::connection('cache')->hasTable('transport_metric_buckets'));
        $this->assertDatabaseHas('cash_table_moves', ['id' => 51, 'status' => 'applied_pending']);
        $migration->up();
        $this->assertTrue(Schema::hasIndex('cash_table_moves', ['status', 'created_at']));
    }
}
