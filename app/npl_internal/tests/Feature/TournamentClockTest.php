<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class TournamentClockTest extends TestCase
{
    use RefreshDatabase;

    private function tournament(array $overrides = []): int
    {
        $result = app(TournamentService::class)->create(array_merge([
            'name' => 'Friday Deepstack',
            'venue_name' => 'Rockdale RSL',
            'starting_stack' => 20000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'addon_chips' => 30000,
            'addon_price_cents' => 5000,
            'max_addons_per_player' => 1,
            'buy_in_price_cents' => 10000,
            // Required since the desk cut-off work: a session cannot open
            // without a level at which registration shuts.
            'registration_closes_at_level' => 3,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
                ['level_no' => 0, 'type' => 'break', 'duration_min' => 10, 'note' => 'Break'],
                ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'duration_min' => 20],
            ],
        ], $overrides));

        return (int) $result['session']['id'];
    }

    public function test_a_new_tournament_starts_in_draft_with_its_structure(): void
    {
        $id = $this->tournament();
        $data = app(TournamentService::class)->show($id);

        $this->assertSame('draft', $data['session']['status']);
        $this->assertCount(4, $data['levels']);
        $this->assertSame('break', $data['levels'][2]['type']);
        $this->assertFalse($data['clock']['running']);
        // Blinds are pre-formatted so every display renders them identically.
        $this->assertSame('100 / 200', $data['clock']['current_level']['label']);
    }

    public function test_the_clock_counts_down_from_server_time_and_survives_a_reload(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);

        $state = $clock->start($id);
        $this->assertTrue($state['running']);
        $this->assertSame(20 * 60 * 1000, $state['level_duration_ms']);
        $this->assertEqualsWithDelta(20 * 60 * 1000, $state['remaining_ms'], 2000);

        $this->travel(5)->minutes();

        // A completely fresh read — no client state involved, which is the
        // whole point: EdgeHost lost the tournament on reload.
        $reloaded = app(TournamentClockService::class)->state($id);
        $this->assertEqualsWithDelta(15 * 60 * 1000, $reloaded['remaining_ms'], 2000);
        $this->assertSame(0, $reloaded['level_index']);
    }

    public function test_pausing_freezes_the_clock_and_resuming_keeps_the_time_that_was_left(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);
        $clock->start($id);

        $this->travel(5)->minutes();
        $paused = $clock->pause($id);
        $this->assertSame('paused', $paused['status']);
        $remainingAtPause = $paused['remaining_ms'];

        // Time passing while paused must not consume the level.
        $this->travel(30)->minutes();
        $stillPaused = $clock->state($id);
        $this->assertEqualsWithDelta($remainingAtPause, $stillPaused['remaining_ms'], 2000);

        $resumed = $clock->resume($id);
        $this->assertSame('running', $resumed['status']);
        $this->assertEqualsWithDelta($remainingAtPause, $resumed['remaining_ms'], 2000);
        // Still on level 1 — a 30 minute pause did not skip anything.
        $this->assertSame(0, $resumed['level_index']);
    }

    public function test_levels_advance_automatically_and_catch_up_after_a_long_gap(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);
        $clock->start($id);

        // One level elapses.
        $this->travel(21)->minutes();
        $state = $clock->state($id);
        $this->assertSame(1, $state['level_index']);
        $this->assertSame(400, $state['current_level']['big_blind']);

        // The machine sleeps through the rest of level 2 AND the break.
        $this->travel(31)->minutes();
        $state = app(TournamentClockService::class)->state($id);
        $this->assertSame(3, $state['level_index'], 'The clock must catch up through every elapsed level.');
        $this->assertSame(600, $state['current_level']['big_blind']);
    }

    public function test_the_clock_holds_on_the_final_level_rather_than_running_off_the_end(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);
        $clock->start($id);

        $this->travel(10)->hours();
        $state = $clock->state($id);

        $this->assertSame(3, $state['level_index']);
        $this->assertSame(0, $state['remaining_ms']);
    }

    public function test_a_break_level_is_flagged_so_displays_can_render_it_differently(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);
        $clock->start($id);
        $clock->goToLevel($id, 2);

        $state = $clock->state($id);
        $this->assertTrue($state['current_level']['is_break']);
        $this->assertSame('Break', $state['current_level']['label']);
        $this->assertSame(600, $state['next_level']['big_blind']);
    }

    public function test_operator_can_jump_levels_and_adjust_the_clock(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);
        $clock->start($id);

        $this->assertSame(1, $clock->nextLevel($id)['level_index']);
        $this->assertSame(0, $clock->previousLevel($id)['level_index']);

        // Jumping restarts the level's full duration.
        $this->travel(10)->minutes();
        $jumped = $clock->goToLevel($id, 1);
        $this->assertEqualsWithDelta(20 * 60 * 1000, $jumped['remaining_ms'], 2000);

        $extended = $clock->adjustTime($id, 120);
        $this->assertEqualsWithDelta(22 * 60 * 1000, $extended['remaining_ms'], 2000);
    }

    public function test_lifecycle_guards_reject_impossible_transitions(): void
    {
        $id = $this->tournament();
        $clock = app(TournamentClockService::class);

        // EdgeHost let you resume something that was never running, finish a
        // draft, or start a finished session. None of that is allowed here.
        try {
            $clock->resume($id);
            $this->fail('Resuming a draft must be refused.');
        } catch (ValidationException $e) {
            $this->assertNotEmpty($e->errors());
        }

        $clock->start($id);

        try {
            $clock->start($id);
            $this->fail('Starting a running tournament must be refused.');
        } catch (ValidationException $e) {
            $this->assertNotEmpty($e->errors());
        }

        $clock->finish($id);

        try {
            $clock->pause($id);
            $this->fail('Pausing a finished tournament must be refused.');
        } catch (ValidationException $e) {
            $this->assertNotEmpty($e->errors());
        }
    }

    public function test_the_blind_structure_is_locked_once_play_starts(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);

        $service->updateStructure($id, [
            ['level_no' => 1, 'type' => 'blind', 'small_blind' => 50, 'big_blind' => 100, 'duration_min' => 15],
        ]);
        $this->assertCount(1, $service->show($id)['levels']);

        app(TournamentClockService::class)->start($id);

        $this->expectException(ValidationException::class);
        $service->updateStructure($id, [
            ['level_no' => 1, 'type' => 'blind', 'small_blind' => 999, 'big_blind' => 1998, 'duration_min' => 15],
        ]);
    }

    public function test_registering_takes_the_buy_in_and_seeds_the_starting_stack(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);
        app(TournamentClockService::class)->start($id);

        $result = $service->register($id, 'ACE2026', 'Ace Nguyen', 1, 3);
        $this->assertFalse($result['already_registered']);

        $players = $service->players($id);
        $this->assertCount(1, $players);
        $this->assertSame(20000, $players[0]['chips']);
        $this->assertSame(10000, $players[0]['spend_cents']);
        $this->assertFalse($players[0]['knocked_out']);

        // Registering again is a no-op, not a second buy-in.
        $repeat = $service->register($id, 'ACE2026', 'Ace Nguyen');
        $this->assertTrue($repeat['already_registered']);
        $this->assertSame(20000, $service->players($id)[0]['chips']);
    }

    public function test_rebuys_and_addons_add_chips_and_respect_their_caps(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);
        app(TournamentClockService::class)->start($id);
        $service->register($id, 'ACE2026', 'Ace');

        $service->act($id, 'ACE2026', 'rebuy');
        $service->act($id, 'ACE2026', 'rebuy');
        $player = $service->act($id, 'ACE2026', 'addon');

        $this->assertSame(20000 + 20000 + 20000 + 30000, $player['chips']);
        $this->assertSame(2, $player['rebuys']);
        $this->assertSame(1, $player['addons']);

        // Caps are enforced here — EdgeHost stored them and never checked.
        try {
            $service->act($id, 'ACE2026', 'rebuy');
            $this->fail('A third rebuy must be refused when the cap is 2.');
        } catch (ValidationException) {
        }

        try {
            $service->act($id, 'ACE2026', 'addon');
            $this->fail('A second add-on must be refused when the cap is 1.');
        } catch (ValidationException) {
        }
    }

    public function test_voiding_an_addon_reverses_chips_and_money(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);
        app(TournamentClockService::class)->start($id);
        $service->register($id, 'ACE2026');

        $service->act($id, 'ACE2026', 'addon');
        $player = $service->act($id, 'ACE2026', 'addon_void');

        $this->assertSame(20000, $player['chips'], 'A voided add-on must leave only the buy-in stack.');
        $this->assertSame(10000, $player['spend_cents']);

        // The void freed the cap, so another add-on is allowed.
        $service->act($id, 'ACE2026', 'addon');
        $this->assertSame(50000, $service->players($id)[0]['chips']);
    }

    public function test_knocked_out_state_is_derived_from_the_newest_ko_or_unko(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);
        app(TournamentClockService::class)->start($id);
        $service->register($id, 'ACE2026');
        $service->register($id, 'BEE2026');

        $service->act($id, 'ACE2026', 'ko');
        $this->assertTrue($service->players($id)[0]['knocked_out']);
        $this->assertSame(1, $service->summary($id)['active_players']);

        $service->act($id, 'ACE2026', 'unko');
        $this->assertFalse($service->players($id)[0]['knocked_out']);
        $this->assertSame(2, $service->summary($id)['active_players']);
    }

    public function test_registration_and_rebuys_close_at_the_configured_level(): void
    {
        $id = $this->tournament(['registration_closes_at_level' => 2]);
        $service = app(TournamentService::class);
        $clock = app(TournamentClockService::class);

        $clock->start($id);
        $service->register($id, 'ACE2026');
        $this->assertTrue($clock->state($id)['registration_open']);

        // Reaching the break closes late registration.
        $clock->goToLevel($id, 2);
        $this->assertFalse($clock->state($id)['registration_open']);

        try {
            $service->register($id, 'LATE2026');
            $this->fail('Late registration must be refused once closed.');
        } catch (ValidationException) {
        }

        // Cut-offs are independent: no rebuy cut-off was set, so rebuys
        // stay open even though registration has closed.
        $service->act($id, 'ACE2026', 'rebuy');
        $this->assertSame(1, $service->players($id)[0]['rebuys']);
    }

    public function test_a_repeated_action_with_the_same_idempotency_key_applies_once(): void
    {
        $id = $this->tournament();
        $service = app(TournamentService::class);
        app(TournamentClockService::class)->start($id);
        $service->register($id, 'ACE2026');

        $service->act($id, 'ACE2026', 'rebuy', ['idempotency_key' => 'desk-tap-1']);
        $service->act($id, 'ACE2026', 'rebuy', ['idempotency_key' => 'desk-tap-1']);

        $this->assertSame(1, DB::table('tournament_actions')->where('action', 'rebuy')->count());
        $this->assertSame(40000, $service->players($id)[0]['chips']);
    }

    public function test_the_clock_state_carries_everything_a_display_ticks_from(): void
    {
        // The dedicated clock route is gone (displays read the clock inside
        // desk seating) — the STATE contract is what matters.
        $id = $this->tournament();
        $this->postJson("/api/v1/tournaments/{$id}/start")->assertOk();

        $clock = app(TournamentClockService::class)->state($id);

        // Everything a client needs to render a smooth local countdown.
        $this->assertTrue($clock['running']);
        $this->assertNotNull($clock['server_time_ms']);
        $this->assertNotNull($clock['level_started_at']);
        $this->assertArrayHasKey('remaining_ms', $clock);
        $this->assertSame('100 / 200', $clock['current_level']['label']);
    }
}
