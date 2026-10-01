<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudException;
use App\Services\Sync\SyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class TransportRecoveryTest extends TestCase
{
    use RefreshDatabase;

    #[\PHPUnit\Framework\Attributes\DataProvider('unconfirmedReads')]
    public function test_an_unconfirmed_seating_read_preserves_the_existing_mirror(int $status, array $body): void
    {
        Http::preventStrayRequests();
        DB::table('mirror_session_tables')->insert([
            'session_table_key' => '701:1:1', 'session_id' => 701, 'table_number' => 1,
            'seat_number' => 1, 'max_seats' => 8, 'table_status' => 'open', 'table_kind' => 'house',
            'player_npl_id' => 'PLAYER1', 'registration_status' => 'registered',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        Http::fake(fn () => Http::response($body, $status));
        try {
            app(SyncService::class)->refreshSeatingFor(7, [701]);
            $this->fail('A failed read must not count as a successful empty snapshot.');
        } catch (CloudException $error) {
            $this->assertDatabaseHas('mirror_session_tables', ['session_id' => 701, 'player_npl_id' => 'PLAYER1']);
        }
    }

    public static function unconfirmedReads(): array
    {
        return [
            'refused licence' => [403, ['ok' => false]],
            'expired licence' => [401, ['ok' => false]],
            'malformed successful response' => [200, ['message' => 'proxy response']],
            'server temporarily unavailable' => [503, ['ok' => false]],
        ];
    }
}
