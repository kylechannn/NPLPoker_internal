<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * No preparation screen: a game opens straight into registration on the
 * super admin's game structure defaults. The defaults live on the NPL
 * cloud, are mirrored here so a night still opens offline, and are saved
 * from the Game Structure tab AS the signed-in super admin — never with
 * the desk's CD-Key lease.
 */
class GameStructureDefaultsTest extends TestCase
{
    use RefreshDatabase;

    /** What the cloud answers once a super admin has saved defaults. */
    private function cloudDefaults(array $overrides = []): array
    {
        return array_replace_recursive([
            'tournament' => [
                'game_type' => 'tournament',
                'settings' => [
                    'seats_per_table' => 9,
                    'starting_stack' => 25000,
                    'buy_in_price_cents' => 15000,
                    'rebuy_tiers' => [['price_cents' => 10000, 'chips' => 20000], ['price_cents' => 20000, 'chips' => 45000]],
                    'max_rebuys_per_player' => 2,
                    'addon_tiers' => [['price_cents' => 5000, 'chips' => 30000]],
                    'max_addons_per_player' => 1,
                    'jackpot_enabled' => true,
                    'jackpot_price_cents' => 1000,
                    'registration_closes_at_level' => 3,
                    'rebuy_closes_at_level' => null,
                    'addon_closes_at_level' => 4,
                    'jackpot_closes_at_level' => null,
                    'chip_denominations' => '25, 100, 500',
                    'pattern' => ['levels' => 3, 'duration_min' => 20, 'small_blind' => 100, 'mode' => 'multiply', 'step' => 2],
                ],
                'levels' => [
                    ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'ante' => 0, 'bb_ante' => 0, 'duration_min' => 20, 'sort_order' => 1, 'note' => null],
                    ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'ante' => 0, 'bb_ante' => 400, 'duration_min' => 20, 'sort_order' => 2, 'note' => null],
                    ['level_no' => 2, 'type' => 'break', 'small_blind' => 0, 'big_blind' => 0, 'ante' => 0, 'bb_ante' => 0, 'duration_min' => 10, 'sort_order' => 3, 'note' => 'Break'],
                    ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'ante' => 0, 'bb_ante' => 600, 'duration_min' => 20, 'sort_order' => 4, 'note' => null],
                ],
                'updated_at' => '2026-09-26T09:00:00+00:00',
                'updated_by' => ['id' => 1, 'login' => 'kyle', 'display_name' => 'Kyle Chan'],
            ],
            'cash' => [
                'game_type' => 'cash',
                'settings' => [
                    'buy_in_price_cents' => 5000,
                    'starting_stack' => 12000,
                    'seats_per_table' => 8,
                    'topups_enabled' => true,
                    'rebuy_price_cents' => 5000,
                    'rebuy_chips' => 12000,
                    'jackpot_enabled' => true,
                    'jackpot_price_cents' => 500,
                    'cash_reg_close_min' => 30,
                    'cash_jackpot_close_min' => 0,
                ],
                'levels' => null,
                'updated_at' => '2026-09-26T09:00:00+00:00',
                'updated_by' => ['id' => 1, 'login' => 'kyle', 'display_name' => 'Kyle Chan'],
            ],
            'updated_at' => '2026-09-26T09:00:00+00:00',
        ], $overrides);
    }

    private function mirrorSession(int $sessionId = 91, string $title = 'Friday Deepstack'): void
    {
        DB::table('mirror_game_sessions')->insert([
            'session_id' => $sessionId,
            'source_type' => 'daily_game',
            'category' => 'daily_game',
            'venue_id' => 7,
            'venue_name' => 'Rockdale RSL',
            'title' => $title,
            'session_date' => now()->toDateString(),
            'start_time' => '19:00',
            'status' => 'scheduled',
            'registrations_count' => 0,
            'is_open_for_registration' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_a_game_opens_on_the_built_in_structure_until_the_super_admin_has_saved_one(): void
    {
        $this->getJson('/api/v1/console/game-structure')
            ->assertOk()
            ->assertJsonPath('data.tournament.source', 'built_in')
            ->assertJsonPath('data.cash.source', 'built_in')
            ->assertJsonPath('data.tournament.settings.registration_closes_at_level', 6);

        $created = $this->postJson('/api/v1/tournaments/open', [
            'game_type' => 'tournament',
            'venue_id' => 7,
            'venue_name' => 'Rockdale RSL',
        ])->assertStatus(201)->json('data');

        $this->assertSame('draft', $created['session']['status']);
        $this->assertSame(20000, $created['session']['starting_stack']);
        $this->assertSame(10000, $created['session']['buy_in_price_cents']);
        $this->assertSame(6, $created['session']['registration_closes_at_level']);
        $this->assertSame([['price_cents' => 10000, 'chips' => 20000]], $created['session']['rebuy_tiers']);
        $this->assertStringEndsWith('— Rockdale RSL', $created['session']['name']);
        // 18 generated levels with a break every 6 (none after the last).
        $this->assertCount(20, $created['levels']);
        $this->assertSame('break', $created['levels'][6]['type']);
    }

    public function test_the_cloud_defaults_are_mirrored_and_every_open_uses_them(): void
    {
        Http::fake(['*/api/v1/internal/game-structure' => Http::response(['ok' => true, 'data' => $this->cloudDefaults()], 200)]);

        $this->postJson('/api/v1/console/game-structure/pull')
            ->assertOk()
            ->assertJsonPath('data.refreshed', true)
            ->assertJsonPath('data.tournament.source', 'cloud')
            ->assertJsonPath('data.tournament.updated_by', 'Kyle Chan')
            ->assertJsonPath('data.tournament.cloud_updated_at', '2026-09-26T09:00:00+00:00')
            ->assertJsonPath('data.cash.settings.cash_reg_close_min', 30);

        $this->assertSame(2, DB::table('game_structure_defaults')->count());

        $this->mirrorSession();

        $created = $this->postJson('/api/v1/tournaments/open', [
            'game_type' => 'tournament',
            'game_session_id' => 91,
            'venue_id' => 7,
            'venue_name' => 'Rockdale RSL',
        ])->assertStatus(201)->json('data');

        $session = $created['session'];
        $this->assertSame(91, $session['game_session_id']);
        $this->assertSame(15000, $session['buy_in_price_cents']);
        $this->assertSame(25000, $session['starting_stack']);
        $this->assertSame(9, $session['seats_per_table']);
        $this->assertSame(3, $session['registration_closes_at_level']);
        $this->assertSame(4, $session['addon_closes_at_level']);
        $this->assertNull($session['rebuy_closes_at_level']);
        $this->assertSame(2, $session['max_rebuys_per_player']);
        $this->assertCount(2, $session['rebuy_tiers']);
        $this->assertSame(45000, $session['rebuy_tiers'][1]['chips']);
        $this->assertSame('25, 100, 500', $session['settings']['chip_denominations']);
        // Named after the cloud game, dated like the export lists nights.
        $this->assertStringEndsWith('— Friday Deepstack', $session['name']);
        $this->assertSame([100, 200, 0, 300], array_column($created['levels'], 'small_blind'));
        $this->assertSame('break', $created['levels'][2]['type']);

        // The desk's lifecycle is untouched: the same session is the room's
        // one active slot, with the admin QR the sidebar renders.
        $this->getJson('/api/v1/tournaments/active')
            ->assertOk()
            ->assertJsonPath('data.active.id', $session['id'])
            ->assertJsonPath('data.active.game_type', 'tournament');
    }

    public function test_a_cash_desk_opens_from_the_cash_defaults(): void
    {
        Http::fake(['*/api/v1/internal/game-structure' => Http::response(['ok' => true, 'data' => $this->cloudDefaults([
            'cash' => ['settings' => ['topups_enabled' => false, 'cash_jackpot_close_min' => 45]],
        ])], 200)]);
        $this->postJson('/api/v1/console/game-structure/pull')->assertOk();

        $created = $this->postJson('/api/v1/tournaments/open', [
            'game_type' => 'cash',
            'venue_id' => 7,
            'venue_name' => 'Rockdale RSL',
        ])->assertStatus(201)->json('data');

        $session = $created['session'];
        $this->assertSame('cash', $session['game_type']);
        $this->assertSame(5000, $session['buy_in_price_cents']);
        $this->assertSame(12000, $session['starting_stack']);
        // Top-ups off: no rebuy tier, no rebuy allowance.
        $this->assertSame([], $session['rebuy_tiers']);
        $this->assertSame(0, $session['max_rebuys_per_player']);
        $this->assertTrue($session['jackpot_enabled']);
        $this->assertSame(500, $session['jackpot_price_cents']);
        $this->assertNull($session['registration_closes_at_level']);
        $this->assertSame(30, (int) DB::table('tournament_sessions')->where('id', $session['id'])->value('cash_reg_close_min'));
        $this->assertSame(45, (int) DB::table('tournament_sessions')->where('id', $session['id'])->value('cash_jackpot_close_min'));
    }

    public function test_opening_keeps_the_one_session_at_a_time_rule(): void
    {
        $first = (int) $this->postJson('/api/v1/tournaments/open', ['game_type' => 'tournament', 'venue_name' => 'Rockdale RSL'])
            ->assertStatus(201)->json('data.session.id');

        // A second open refuses until the operator confirms the erase.
        $this->postJson('/api/v1/tournaments/open', ['game_type' => 'cash', 'venue_name' => 'Rockdale RSL'])
            ->assertStatus(422);

        $second = (int) $this->postJson('/api/v1/tournaments/open', [
            'game_type' => 'cash',
            'venue_name' => 'Rockdale RSL',
            'replace_session_id' => $first,
        ])->assertStatus(201)->json('data.session.id');

        $this->assertNotSame($first, $second);
        $this->assertNull(DB::table('tournament_sessions')->where('id', $first)->first());
        $this->getJson('/api/v1/tournaments/active')->assertOk()->assertJsonPath('data.active.id', $second);
    }

    public function test_an_offline_pull_keeps_the_mirror_and_says_so(): void
    {
        Http::fake(['*/api/v1/internal/game-structure' => Http::response(['ok' => true, 'data' => $this->cloudDefaults()], 200)]);
        $this->postJson('/api/v1/console/game-structure/pull')->assertOk()->assertJsonPath('data.refreshed', true);

        Http::fake(fn () => throw new ConnectionException('cURL error 6'));

        $this->postJson('/api/v1/console/game-structure/pull')
            ->assertOk()
            ->assertJsonPath('data.refreshed', false)
            ->assertJsonPath('data.tournament.source', 'cloud')
            ->assertJsonPath('data.tournament.settings.buy_in_price_cents', 15000);
        $this->assertNotNull($this->getJson('/api/v1/console/game-structure?refresh=1')->assertOk()->json('data.warning'));
    }

    public function test_a_super_admin_save_goes_to_the_cloud_as_them_and_lands_in_the_mirror(): void
    {
        Http::fake(['*/api/v1/admin/os/game-structure' => Http::response(['ok' => true, 'message' => 'OS game structure saved.', 'data' => $this->cloudDefaults()], 200)]);

        $body = ['tournament' => $this->cloudDefaults()['tournament']];

        // No sign-in on the request: nothing goes anywhere.
        $this->putJson('/api/v1/console/game-structure', $body)
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'ADMIN_SIGN_IN_REQUIRED');
        Http::assertNothingSent();

        $this->withToken('jwt-super-admin')
            ->putJson('/api/v1/console/game-structure', $body)
            ->assertOk()
            ->assertJsonPath('data.refreshed', true)
            ->assertJsonPath('data.tournament.source', 'cloud')
            ->assertJsonPath('data.tournament.settings.buy_in_price_cents', 15000);

        // As the person, with a write key — never as the desk alone.
        Http::assertSent(fn (ClientRequest $request): bool => $request->method() === 'PUT'
            && str_contains($request->url(), '/api/v1/admin/os/game-structure')
            && $request->hasHeader('Authorization', 'Bearer jwt-super-admin')
            && $request->hasHeader('Idempotency-Key')
            && $request['tournament']['settings']['buy_in_price_cents'] === 15000);

        $this->assertSame('Kyle Chan', DB::table('game_structure_defaults')->where('game_type', 'tournament')->value('updated_by_name'));
    }

    public function test_the_clouds_refusals_read_back_plainly(): void
    {
        $body = ['cash' => $this->cloudDefaults()['cash']];

        // Http::fake() appends stubs and the first match wins, so the three
        // refusals ride ONE closure that answers in order.
        $answers = [
            Http::response(['ok' => false, 'error' => ['code' => 'UNAUTHENTICATED', 'message' => 'Unauthenticated.']], 401),
            Http::response(['ok' => false, 'error' => ['code' => 'ADMIN_ROLE_FORBIDDEN', 'message' => 'This admin role cannot perform this operation.']], 403),
            Http::response(['ok' => false, 'error' => [
                'code' => 'VALIDATION_FAILED',
                'message' => 'Validation error.',
                'details' => ['tournament.settings.registration_closes_at_level' => ['Cut-off must be between 1 and 4 (the ladder has 4 rows).']],
            ]], 422),
        ];
        Http::fake(function () use (&$answers) {
            return array_shift($answers);
        });

        $this->withToken('jwt-stale')->putJson('/api/v1/console/game-structure', $body)
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'ADMIN_SIGN_IN_EXPIRED');

        $this->withToken('jwt-plain-admin')->putJson('/api/v1/console/game-structure', $body)
            ->assertStatus(403)
            ->assertJsonPath('error.code', 'ADMIN_ROLE_FORBIDDEN');

        $this->withToken('jwt-super-admin')->putJson('/api/v1/console/game-structure', $body)
            ->assertStatus(422)
            ->assertJsonPath('error.message', 'Cut-off must be between 1 and 4 (the ladder has 4 rows).');

        $this->assertSame(0, DB::table('game_structure_defaults')->count());
    }
}
