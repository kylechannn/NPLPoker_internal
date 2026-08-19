<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

/**
 * Finishing requires the top 16 — or the WHOLE field when fewer than 16
 * played — each identified by scan or NPL ID. Applies to every
 * tournament (daily games, special events, championships); cash games
 * rank nobody and are exempt.
 */
class FinishTop16Test extends TestCase
{
    use RefreshDatabase;

    private function tournament(): int
    {
        $result = app(TournamentService::class)->create([
            'name' => 'Top16 Night',
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

    private function enter(int $sessionId, string $nplId, string $name): void
    {
        DB::table('mirror_players')->insert([
            'cloud_id' => crc32($nplId),
            'npl_id' => $nplId,
            'display_name' => $name,
            'status' => 'active',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        app(TournamentDeskService::class)->apply($sessionId, $nplId, 'buy_in');
    }

    public function test_a_small_field_must_place_every_player(): void
    {
        $id = $this->tournament();
        $this->enter($id, 'NPL1', 'One');
        $this->enter($id, 'NPL2', 'Two');
        $this->enter($id, 'NPL3', 'Three');

        try {
            app(TournamentDeskService::class)->finishWithResults($id, [
                ['npl_id' => 'NPL1', 'position' => 1],
                ['npl_id' => 'NPL2', 'position' => 2],
            ]);
            $this->fail('Finishing with 2 of 3 places identified must be refused.');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('2 of 3 confirmed', $e->getMessage());
        }

        $result = app(TournamentDeskService::class)->finishWithResults($id, [
            ['npl_id' => 'NPL1', 'position' => 1],
            ['npl_id' => 'NPL2', 'position' => 2],
            ['npl_id' => 'NPL3', 'position' => 3],
        ]);

        $this->assertTrue($result['finished']);
        $this->assertSame(3, $result['recorded']);
    }

    public function test_a_big_field_requires_exactly_the_top_sixteen(): void
    {
        $id = $this->tournament();

        // 20 in the field — seeded straight into the entries/ledger so the
        // test stays fast; the gate reads entries, not the buy-in path.
        for ($i = 1; $i <= 20; $i++) {
            DB::table('tournament_entries')->insert([
                'tournament_session_id' => $id,
                'player_npl_id' => 'NPL'.$i,
                'player_name' => 'Player '.$i,
                'status' => 'active',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $places = fn (int $count): array => array_map(
            fn (int $i): array => ['npl_id' => 'NPL'.$i, 'position' => $i],
            range(1, $count),
        );

        try {
            app(TournamentDeskService::class)->finishWithResults($id, $places(15));
            $this->fail('Fifteen of sixteen places must be refused.');
        } catch (ValidationException $e) {
            $this->assertStringContainsString('15 of 16 confirmed', $e->getMessage());
        }

        $result = app(TournamentDeskService::class)->finishWithResults($id, $places(16));
        $this->assertTrue($result['finished']);
    }

    public function test_placements_outside_the_field_do_not_count(): void
    {
        $id = $this->tournament();
        $this->enter($id, 'NPL1', 'One');

        // A stranger's NPL ID cannot cover a place — identity is the point.
        $this->expectException(ValidationException::class);
        app(TournamentDeskService::class)->finishWithResults($id, [
            ['npl_id' => 'STRANGER1', 'position' => 1],
        ]);
    }

    public function test_cash_games_still_finish_with_no_placements(): void
    {
        $id = $this->tournament();
        DB::table('tournament_sessions')->where('id', $id)->update(['game_type' => 'cash']);
        $this->enter($id, 'NPL1', 'One');

        $result = app(TournamentDeskService::class)->finishWithResults($id, []);
        $this->assertTrue($result['finished']);
    }

    public function test_the_finalise_endpoint_accepts_sixteen_positions(): void
    {
        $id = $this->tournament();

        for ($i = 1; $i <= 16; $i++) {
            DB::table('tournament_entries')->insert([
                'tournament_session_id' => $id,
                'player_npl_id' => 'NPL'.$i,
                'player_name' => 'Player '.$i,
                'status' => 'active',
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $placements = array_map(
            fn (int $i): array => ['npl_id' => 'NPL'.$i, 'position' => $i],
            range(1, 16),
        );

        $this->postJson('/api/v1/desk/'.$id.'/finalise', ['placements' => $placements])
            ->assertOk()
            ->assertJsonPath('data.result.finished', true)
            ->assertJsonPath('data.result.recorded', 16);
    }
}
