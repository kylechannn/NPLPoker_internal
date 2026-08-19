<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * The cashier's book: every money/roster action emits one cashier_event
 * into the money outbox (queued, offline-safe, idempotent), and the local
 * Cashier tab report reconciles the till from the ledger alone.
 */
class CashierTest extends TestCase
{
    use RefreshDatabase;

    private function tournament(): int
    {
        $result = app(TournamentService::class)->create([
            'name' => 'Cashier Night',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'starting_stack' => 20000,
            'buy_in_price_cents' => 10000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'addon_chips' => 30000,
            'addon_price_cents' => 4000,
            'max_addons_per_player' => 1,
            'jackpot_enabled' => true,
            'jackpot_price_cents' => 1000,
            'registration_closes_at_level' => 3,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
                ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'duration_min' => 20],
            ],
        ]);

        return (int) $result['session']['id'];
    }

    private function mirrorPlayer(string $nplId, string $name): void
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

    private function cashierEvents(): \Illuminate\Support\Collection
    {
        return DB::table('sync_outbox')
            ->where('entity_type', 'cashier_event')
            ->orderBy('id')
            ->get()
            ->map(fn (object $row): array => (array) json_decode((string) $row->payload, true));
    }

    public function test_every_money_action_lands_in_the_outbox_with_the_till_amount(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL100', 'Alice Chen');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL100', 'buy_in');
        $desk->apply($id, 'NPL100', 'rebuy');
        $desk->apply($id, 'NPL100', 'addon');

        $events = $this->cashierEvents();

        $this->assertCount(3, $events);
        $this->assertSame(['buy_in', 'rebuy', 'addon'], $events->pluck('kind')->all());
        $this->assertSame([10000, 5000, 4000], $events->pluck('amount_cents')->all());
        $this->assertSame('Alice Chen', $events[0]['player_name']);
        $this->assertSame('Cashier Night', $events[0]['session_name']);
        $this->assertNotSame($events[0]['reference'], $events[1]['reference']);
    }

    public function test_replayed_sale_never_double_records(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL200', 'Bob Lam');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL200', 'buy_in');

        // Keyed replay (rebuy/addon thread the key onto the ledger row):
        // the short-circuit answers success without a second event.
        $desk->apply($id, 'NPL200', 'rebuy', ['idempotency_key' => 'sale-1']);
        $replay = $desk->apply($id, 'NPL200', 'rebuy', ['idempotency_key' => 'sale-1']);
        $this->assertTrue($replay['replayed']);
        $this->assertSame(1, $this->cashierEvents()->where('kind', 'rebuy')->count());

        // Buy-in double-tap is stopped by the "already bought in" gate —
        // an exception before any ledger or cashier write.
        try {
            $desk->apply($id, 'NPL200', 'buy_in');
            $this->fail('A second buy-in must be refused.');
        } catch (\Illuminate\Validation\ValidationException) {
            // expected
        }
        $this->assertSame(1, $this->cashierEvents()->where('kind', 'buy_in')->count());
    }

    public function test_removal_is_recorded_and_the_money_stays_on_the_report(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL300', 'Carol Wu');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL300', 'buy_in');
        $desk->removePlayer($id, 'NPL300');

        $kinds = $this->cashierEvents()->pluck('kind')->all();
        $this->assertSame(['buy_in', 'removed'], $kinds);

        $report = $desk->cashierReport($id);
        $this->assertSame(1, count($report['players']));
        $this->assertSame('removed', $report['players'][0]['status']);
        $this->assertSame(10000, $report['players'][0]['paid_cents'], 'what was paid was paid');
        $this->assertSame(10000, $report['totals']['gross_cents']);
    }

    public function test_cashier_report_sums_the_whole_till(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL400', 'Dan Ng');
        $this->mirrorPlayer('NPL500', 'Eve Ko');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL400', 'buy_in');
        $desk->apply($id, 'NPL400', 'rebuy');
        $desk->apply($id, 'NPL500', 'buy_in');
        $desk->apply($id, 'NPL500', 'addon');

        $report = $desk->cashierReport($id);

        $this->assertSame(2, $report['totals']['buy_in']['count']);
        $this->assertSame(20000, $report['totals']['buy_in']['cents']);
        $this->assertSame(5000, $report['totals']['rebuy']['cents']);
        $this->assertSame(4000, $report['totals']['addon']['cents']);
        $this->assertSame(29000, $report['totals']['gross_cents']);

        $byId = collect($report['players'])->keyBy('npl_id');
        $this->assertSame(15000, $byId['NPL400']['paid_cents']);
        $this->assertSame(1, $byId['NPL500']['addon']['count']);
    }

    public function test_cashier_endpoints_serve_the_tab(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL600', 'Fay Ho');
        app(TournamentDeskService::class)->apply($id, 'NPL600', 'buy_in');

        $sessions = $this->getJson('/api/v1/desk/cashier/sessions')->assertOk()->json('data.sessions');
        $this->assertSame($id, $sessions[0]['id']);

        $report = $this->getJson('/api/v1/desk/'.$id.'/cashier')->assertOk()->json('data');
        $this->assertSame(10000, $report['totals']['gross_cents']);
        $this->assertSame('Fay Ho', $report['players'][0]['player_name']);
    }
}
