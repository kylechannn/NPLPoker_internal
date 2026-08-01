<?php

namespace Tests\Feature;

use App\Services\Sync\DeltaSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

/**
 * The ETag must never outrun the rows.
 *
 * Field incident 2026-08-01: a code update added a mirror column, the venue
 * machine pulled BEFORE its schema migrated, the upsert failed — but the
 * fresh ETag was already persisted. Every later pull sent that current-state
 * ETag, the cloud answered 304, and the wheel sat stale while sync reported
 * "unchanged". The ETag may only be stored once the entity fully applied.
 */
class DeltaEtagIntegrityTest extends TestCase
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

    private function fakeWheelFeed(): void
    {
        $row = [
            'id' => 41,
            'wheel' => 'golden',
            'label' => 'Cash Prize',
            'line_one' => '$500',
            'line_two' => 'CASH',
            'hue' => 'gold',
            'weight' => 10,
            'sort_order' => 0,
            'benefit_type' => 'voucher',
            'voucher_type' => 'cash_prize',
            'points_amount' => null,
            'value_cents' => 50000,
            'updated_at' => now()->toIso8601String(),
        ];

        Http::fake(function ($request) use ($row) {
            $url = $request->url();

            if (str_contains($url, '/internal/sync/wheel_prizes/ids')) {
                return Http::response(['ok' => true, 'data' => [
                    'entity' => 'wheel_prizes', 'ids' => [41], 'count' => 1,
                    'server_time' => now()->toIso8601String(),
                ]], 200);
            }

            if (str_contains($url, '/internal/sync/wheel_prizes')) {
                return Http::response(['ok' => true, 'data' => [
                    'entity' => 'wheel_prizes',
                    'upserts' => [$row],
                    'next_cursor' => null,
                    'has_more' => false,
                    'count' => 1,
                    'server_time' => now()->toIso8601String(),
                    'watermark' => $row['updated_at'],
                ]], 200, ['ETag' => 'W/"wheel_prizes-1-999"']);
            }

            return Http::response(['ok' => true, 'data' => []], 200);
        });
    }

    public function test_a_failed_apply_never_persists_the_fresh_etag(): void
    {
        $this->fakeWheelFeed();

        // Reproduce the field failure: the feed carries a column this
        // machine's schema does not have yet.
        Schema::table('mirror_wheel_prizes', function ($table): void {
            $table->dropIndex(['wheel']);
            $table->dropColumn('wheel');
        });

        try {
            app(DeltaSyncService::class)->sync('wheel_prizes');
            $this->fail('The upsert into a missing column should have thrown.');
        } catch (\Throwable) {
            // Expected.
        }

        $state = DB::table('sync_entity_states')->where('entity', 'wheel_prizes')->first();
        $this->assertSame('failed', $state->status);
        // The poison: before the fix this held W/"wheel_prizes-1-999" and
        // every later pull 304'd against rows the mirror never received.
        $this->assertNull($state->etag);

        // Schema catches up (migrate on boot) — the SAME pull now lands.
        Schema::table('mirror_wheel_prizes', function ($table): void {
            $table->string('wheel', 10)->default('normal')->index();
        });

        $result = app(DeltaSyncService::class)->sync('wheel_prizes');

        $this->assertSame('ok', $result['status']);
        $this->assertSame(1, $result['upserted']);
        $this->assertSame('W/"wheel_prizes-1-999"', DB::table('sync_entity_states')->where('entity', 'wheel_prizes')->value('etag'));
        $this->assertSame('golden', DB::table('mirror_wheel_prizes')->where('cloud_id', 41)->value('wheel'));
        $this->assertSame(50000, (int) DB::table('mirror_wheel_prizes')->where('cloud_id', 41)->value('value_cents'));
    }
}
