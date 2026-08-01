<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentGateService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * The cash desk's timer rules: registration and jackpot cut off a set
 * number of MINUTES after Start game, and the jackpot is a first-buy-in
 * privilege — join it with the buy-in that puts you in the game, or never.
 */
class CashTimeGatesTest extends TestCase
{
    use RefreshDatabase;

    private function cashGame(array $overrides = []): int
    {
        $result = app(TournamentService::class)->create(array_merge([
            'game_type' => 'cash',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'buy_in_price_cents' => 10000,
            'starting_stack' => 10000,
            'rebuy_tiers' => [['price_cents' => 10000, 'chips' => 10000]],
            'max_rebuys_per_player' => 255,
            'seats_per_table' => 8,
            'jackpot_enabled' => true,
            'jackpot_price_cents' => 500,
        ], $overrides));

        return (int) $result['session']['id'];
    }

    private function mirrorPlayer(string $nplId, string $name = 'Test Player'): void
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

    public function test_time_gates_close_minutes_after_start_and_pause_with_the_clock(): void
    {
        $id = $this->cashGame([
            'cash_reg_close_min' => 60,
            'cash_jackpot_close_min' => 30,
        ]);

        // Before Start game the full window shows and everything is open.
        $gates = app(TournamentGateService::class)->gates($id);
        $this->assertTrue($gates['registration']['open']);
        $this->assertSame(60 * 60_000, $gates['registration']['closes_in_ms']);
        $this->assertTrue($gates['jackpot']['open']);
        $this->assertSame(30 * 60_000, $gates['jackpot']['closes_in_ms']);
        // Rebuys never cut off at a cash desk.
        $this->assertNull($gates['rebuy']['closes_in_ms']);

        app(TournamentClockService::class)->start($id);

        // 31 minutes of play: jackpot shut, registration still open.
        Carbon::setTestNow(now()->addMinutes(31));
        $gates = app(TournamentGateService::class)->gates($id);
        $this->assertTrue($gates['registration']['open']);
        $this->assertTrue($gates['registration']['closes_in_ms'] <= 29 * 60_000);
        $this->assertFalse($gates['jackpot']['open']);
        $this->assertStringContainsString('30 minutes after the start', (string) $gates['jackpot']['reason']);

        // 61 minutes: registration shut too — a new face is refused.
        Carbon::setTestNow(now()->addMinutes(30));
        $this->mirrorPlayer('NPLLATE1');

        try {
            app(TournamentDeskService::class)->apply($id, 'NPLLATE1', 'buy_in');
            $this->fail('Registration should have closed 60 minutes after start.');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('60 minutes after the start', json_encode($e->errors()));
        }

        // Rebuys stay open regardless.
        $this->assertTrue(app(TournamentGateService::class)->gates($id)['rebuy']['open']);

        Carbon::setTestNow();
    }

    public function test_cash_jackpot_rides_the_first_buy_in_or_never(): void
    {
        $id = $this->cashGame();
        app(TournamentClockService::class)->start($id);
        $desk = app(TournamentDeskService::class);

        // The popup's batch: buy_in then jackpot with the first_buy_in flag —
        // exactly what one submit fires for a fresh player.
        $this->mirrorPlayer('NPLCASH1');
        $desk->apply($id, 'NPLCASH1', 'buy_in');
        $desk->apply($id, 'NPLCASH1', 'jackpot', ['first_buy_in' => true]);

        $this->assertTrue((bool) DB::table('tournament_entries')
            ->where('tournament_session_id', $id)
            ->where('player_npl_id', 'NPLCASH1')
            ->value('in_jackpot'));

        // A player who bought in WITHOUT the jackpot cannot join later —
        // with or without the flag once the entry is no longer fresh.
        $this->mirrorPlayer('NPLCASH2');
        $desk->apply($id, 'NPLCASH2', 'buy_in');

        try {
            $desk->apply($id, 'NPLCASH2', 'jackpot');
            $this->fail('A later jackpot join must be refused on a cash desk.');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('first buy-in', json_encode($e->errors()));
        }

        Carbon::setTestNow(now()->addMinutes(10));

        try {
            $desk->apply($id, 'NPLCASH2', 'jackpot', ['first_buy_in' => true]);
            $this->fail('A stale first_buy_in flag must not reopen the jackpot.');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('first buy-in', json_encode($e->errors()));
        }

        Carbon::setTestNow();

        // The scan popup mirrors the rule: a registered cash player sees the
        // jackpot blocked; an unregistered one sees it offered.
        $scan = $desk->scan($id, 'NPLCASH2');
        $jackpotOption = collect($scan['options'])->firstWhere('action', 'jackpot');
        $this->assertFalse($jackpotOption['allowed']);
        $this->assertStringContainsString('first buy-in', (string) $jackpotOption['reason']);

        $this->mirrorPlayer('NPLCASH3');
        $scan = $desk->scan($id, 'NPLCASH3');
        $jackpotOption = collect($scan['options'])->firstWhere('action', 'jackpot');
        $this->assertTrue($jackpotOption['allowed']);
    }
}
