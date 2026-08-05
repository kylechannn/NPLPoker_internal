<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * ONE desk session at a time — cash or tournament — and therefore ONE admin
 * QR at a time: the QR exists from the moment the session is created until
 * it finishes, and a finished session's QR is dead. A mistaken draft can be
 * discarded (only before any buy-in) so it cannot hold the slot forever.
 */
class SingleActiveSessionTest extends TestCase
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

    private function finish(int $id): void
    {
        DB::table('tournament_sessions')->where('id', $id)->update(['status' => 'finished', 'updated_at' => now()]);
    }

    public function test_a_second_session_cannot_open_while_one_is_unfinished(): void
    {
        $this->create();

        $response = $this->postJson('/api/v1/tournaments', $this->payload(['name' => 'Second Try']));

        $response->assertStatus(422);
        $this->assertStringContainsString('Friday Deepstack', (string) $response->json('errors.session.0'));
    }

    public function test_cash_and_tournament_share_the_single_slot(): void
    {
        // An open tournament blocks a cash game…
        $id = $this->create();
        $this->postJson('/api/v1/tournaments', ['game_type' => 'cash', 'name' => 'Cash Night'])
            ->assertStatus(422);
        $this->finish($id);

        // …and an open cash game blocks a tournament.
        $this->postJson('/api/v1/tournaments', ['game_type' => 'cash', 'name' => 'Cash Night'])
            ->assertStatus(201);
        $this->postJson('/api/v1/tournaments', $this->payload())
            ->assertStatus(422);
    }

    public function test_finishing_frees_the_slot(): void
    {
        $first = $this->create();
        $this->finish($first);

        $this->postJson('/api/v1/tournaments', $this->payload(['name' => 'Next Week']))
            ->assertStatus(201);
    }

    public function test_active_reports_the_open_session_with_the_same_qr_the_desk_shows(): void
    {
        // Idle room: no session, no QR.
        $this->getJson('/api/v1/tournaments/active')->assertOk()->assertJsonPath('data.active', null);

        $id = $this->create();

        $active = $this->getJson('/api/v1/tournaments/active')->assertOk()->json('data.active');
        $this->assertSame($id, $active['id']);
        $this->assertSame('draft', $active['status']);
        $this->assertSame('Friday Deepstack', $active['name']);

        // The sidebar QR and the desk dialog QR must be the SAME payload —
        // two dialects would eventually strand one of the scanners.
        $deskQr = $this->getJson("/api/v1/tournaments/{$id}/admin-qr")->assertOk()->json('data.qr');
        $this->assertSame($deskQr, $active['qr']);

        // Finished: the active slot (and its QR) is gone.
        $this->finish($id);
        $this->getJson('/api/v1/tournaments/active')->assertOk()->assertJsonPath('data.active', null);
    }

    public function test_a_finished_sessions_admin_qr_is_dead(): void
    {
        $id = $this->create();
        $this->getJson("/api/v1/tournaments/{$id}/admin-qr")->assertOk();

        $this->finish($id);

        $this->getJson("/api/v1/tournaments/{$id}/admin-qr")->assertStatus(422);
    }

    public function test_an_empty_draft_can_be_discarded_to_free_the_slot(): void
    {
        $id = $this->create();

        $this->deleteJson("/api/v1/tournaments/{$id}")->assertOk();

        $this->getJson('/api/v1/tournaments/active')->assertOk()->assertJsonPath('data.active', null);
        $this->postJson('/api/v1/tournaments', $this->payload(['name' => 'Fresh Start']))
            ->assertStatus(201);
    }

    public function test_a_draft_with_a_buy_in_cannot_be_discarded(): void
    {
        $id = $this->create();

        DB::table('tournament_entries')->insert([
            'tournament_session_id' => $id,
            'player_npl_id' => 'NPL00001',
            'player_name' => 'Test Player',
            'joined_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $this->deleteJson("/api/v1/tournaments/{$id}")->assertStatus(422);
    }

    public function test_a_running_session_cannot_be_discarded(): void
    {
        $id = $this->create();
        $this->postJson("/api/v1/tournaments/{$id}/start")->assertOk();

        $this->deleteJson("/api/v1/tournaments/{$id}")->assertStatus(422);
    }
}
