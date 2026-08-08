<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * The desk can never be wedged by a session nobody finished.
 *
 * Two exits guard the one-session slot: sessions unfinished 12 hours after
 * they opened (or last started) are force-finished by the sweep — players
 * inside or not — and an operator recreating over a wrong session confirms
 * once and the old one is erased. Neither exit ever tells the cloud the
 * game session completed, so any laptop can still host it.
 */
class StaleSessionRecoveryTest extends TestCase
{
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return array_merge([
            'name' => 'Friday Deepstack',
            'venue_name' => 'Rockdale RSL',
            'registration_closes_at_level' => 2,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
            ],
        ], $overrides);
    }

    private function create(array $overrides = []): int
    {
        return (int) $this->postJson('/api/v1/tournaments', $this->payload($overrides))
            ->assertStatus(201)
            ->json('data.session.id');
    }

    private function registerPlayer(int $sessionId, string $nplId = 'NPL00001'): void
    {
        DB::table('tournament_entries')->insert([
            'tournament_session_id' => $sessionId,
            'player_npl_id' => $nplId,
            'player_name' => 'Test Player',
            'joined_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        DB::table('tournament_actions')->insert([
            'tournament_session_id' => $sessionId,
            'player_npl_id' => $nplId,
            'action' => 'buy_in',
            'chips' => 20000,
            'price_cents' => 5000,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    private function backdate(int $sessionId, array $columns): void
    {
        DB::table('tournament_sessions')->where('id', $sessionId)->update($columns);
    }

    public function test_a_stale_session_with_players_inside_is_force_finished_by_the_active_poll(): void
    {
        $id = $this->create();
        $this->registerPlayer($id);
        $this->backdate($id, ['created_at' => now()->subHours(13)]);

        // The sidebar poll is enough to un-wedge the desk.
        $this->getJson('/api/v1/tournaments/active')->assertOk()->assertJsonPath('data.active', null);

        $session = DB::table('tournament_sessions')->where('id', $id)->first();
        $this->assertSame('finished', $session->status);
        $this->assertNotNull($session->finished_at);

        // The retirement is auditable, and the books still ship to the cloud
        // — but the game session is NEVER completed on the cloud's side.
        $this->assertArrayHasKey('force_finished_at', json_decode((string) $session->settings, true));
        $this->assertTrue(DB::table('sync_outbox')->where('entity_type', 'session_report')->exists());
        $this->assertFalse(DB::table('sync_outbox')->where('entity_type', 'session_result')->exists());
    }

    public function test_a_session_started_recently_is_not_swept_even_if_created_long_ago(): void
    {
        $id = $this->create();
        $this->postJson("/api/v1/tournaments/{$id}/start")->assertOk();
        // Doors opened 13 hours ago, but play began just now: leave it be.
        $this->backdate($id, ['created_at' => now()->subHours(13)]);

        $active = $this->getJson('/api/v1/tournaments/active')->assertOk()->json('data.active');
        $this->assertSame($id, $active['id']);
        $this->assertSame('running', $active['status']);
    }

    public function test_a_session_under_12_hours_old_is_not_swept(): void
    {
        $id = $this->create();
        $this->registerPlayer($id);
        $this->backdate($id, ['created_at' => now()->subHours(11)]);

        $active = $this->getJson('/api/v1/tournaments/active')->assertOk()->json('data.active');
        $this->assertSame($id, $active['id']);
    }

    public function test_the_scheduled_command_sweeps_a_session_12_hours_past_its_start(): void
    {
        $id = $this->create();
        $this->postJson("/api/v1/tournaments/{$id}/start")->assertOk();
        $this->registerPlayer($id);
        $this->backdate($id, [
            'created_at' => now()->subHours(20),
            'started_at' => now()->subHours(13),
        ]);

        $this->artisan('tournament:finish-stale')->assertSuccessful();

        $this->assertSame('finished', DB::table('tournament_sessions')->where('id', $id)->value('status'));
    }

    public function test_create_with_the_confirmed_id_erases_the_open_session_and_creates_the_new_one(): void
    {
        $wrong = $this->create(['name' => 'Wrong Night']);
        $this->registerPlayer($wrong);
        DB::table('live_chip_counts')->insert([
            'tournament_session_id' => $wrong,
            'player_npl_id' => 'NPL00001',
            'chips' => 12345,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $created = $this->postJson('/api/v1/tournaments', $this->payload([
            'name' => 'Right Night',
            'replace_session_id' => $wrong,
        ]))->assertStatus(201)->json('data.session.id');

        // The wrong session is gone root and branch…
        $this->assertNull(DB::table('tournament_sessions')->where('id', $wrong)->first());
        $this->assertFalse(DB::table('tournament_entries')->where('tournament_session_id', $wrong)->exists());
        $this->assertFalse(DB::table('tournament_actions')->where('tournament_session_id', $wrong)->exists());
        $this->assertFalse(DB::table('tournament_levels')->where('tournament_session_id', $wrong)->exists());
        $this->assertFalse(DB::table('live_chip_counts')->where('tournament_session_id', $wrong)->exists());

        // …an erase reports nothing and completes nothing on the cloud…
        $this->assertFalse(DB::table('sync_outbox')->whereIn('entity_type', ['session_report', 'session_result'])->exists());

        // …and the new session now holds the slot.
        $active = $this->getJson('/api/v1/tournaments/active')->assertOk()->json('data.active');
        $this->assertSame($created, $active['id']);
        $this->assertSame('Right Night', $active['name']);
    }

    public function test_create_over_a_running_session_works_with_confirmation(): void
    {
        $wrong = $this->create(['name' => 'Wrong Night']);
        $this->postJson("/api/v1/tournaments/{$wrong}/start")->assertOk();
        $this->registerPlayer($wrong);

        $this->postJson('/api/v1/tournaments', $this->payload([
            'name' => 'Right Night',
            'replace_session_id' => $wrong,
        ]))->assertStatus(201);

        $this->assertNull(DB::table('tournament_sessions')->where('id', $wrong)->first());
    }

    public function test_create_with_a_mismatched_replace_id_is_refused_and_erases_nothing(): void
    {
        $open = $this->create(['name' => 'Actually Open']);

        $response = $this->postJson('/api/v1/tournaments', $this->payload([
            'name' => 'Second Try',
            'replace_session_id' => $open + 999,
        ]));

        $response->assertStatus(422);
        $this->assertStringContainsString('changed since you confirmed', (string) $response->json('errors.session.0'));
        $this->assertNotNull(DB::table('tournament_sessions')->where('id', $open)->first());
    }

    public function test_a_rejected_form_never_costs_the_old_session(): void
    {
        $open = $this->create(['name' => 'Actually Open']);
        $this->registerPlayer($open);

        // Cut-off beyond the ladder: validation fails AFTER the replace
        // handshake matched — the old session must survive the mistake.
        $this->postJson('/api/v1/tournaments', $this->payload([
            'name' => 'Bad Form',
            'replace_session_id' => $open,
            'registration_closes_at_level' => 99,
        ]))->assertStatus(422);

        $this->assertNotNull(DB::table('tournament_sessions')->where('id', $open)->first());
        $this->assertSame('draft', DB::table('tournament_sessions')->where('id', $open)->value('status'));
    }
}
