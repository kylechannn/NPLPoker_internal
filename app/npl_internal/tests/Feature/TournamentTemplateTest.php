<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentService;
use App\Services\Tournament\TournamentTemplateService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TournamentTemplateTest extends TestCase
{
    use RefreshDatabase;

    /** Proves a venue can shape every game differently. */
    public function test_each_game_can_customise_its_own_stack_blinds_and_durations(): void
    {
        $service = app(TournamentService::class);

        $turbo = $service->create([
            'registration_closes_at_level' => 1,
            'name' => 'Thursday Turbo',
            'starting_stack' => 10000,
            'max_rebuys_per_player' => 1,
            'levels' => [
                ['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 8],
                ['type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 8],
            ],
        ]);

        $deepstack = $service->create([
            'registration_closes_at_level' => 1,
            'name' => 'Sunday Deepstack',
            'starting_stack' => 50000,
            'max_rebuys_per_player' => 0,
            'levels' => [
                ['type' => 'blind', 'small_blind' => 50, 'big_blind' => 100, 'ante' => 25, 'duration_min' => 40],
                ['type' => 'break', 'duration_min' => 20, 'note' => 'Dinner'],
                ['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 40],
            ],
        ]);

        // Two games on the same machine, entirely different shapes.
        $this->assertSame(10000, $turbo['session']['starting_stack']);
        $this->assertSame(8, $turbo['levels'][0]['duration_min']);
        $this->assertCount(2, $turbo['levels']);

        $this->assertSame(50000, $deepstack['session']['starting_stack']);
        $this->assertSame(40, $deepstack['levels'][0]['duration_min']);
        $this->assertSame(25, $deepstack['levels'][0]['ante']);
        $this->assertSame('Dinner', $deepstack['levels'][1]['note']);
        $this->assertSame(0, $deepstack['session']['max_rebuys_per_player']);
    }

    public function test_a_setup_can_be_saved_as_a_template_and_reused_for_a_fast_start(): void
    {
        $service = app(TournamentService::class);
        $templates = app(TournamentTemplateService::class);

        $original = $service->create([
            'registration_closes_at_level' => 1,
            'name' => 'Friday Deepstack',
            'starting_stack' => 30000,
            'rebuy_price_cents' => 5500,
            'max_addons_per_player' => 2,
            'levels' => [
                ['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 25],
                ['type' => 'break', 'duration_min' => 15],
                ['type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 25],
            ],
        ]);

        // Capture the whole setup from the tournament we just tuned.
        $template = $templates->save([
            'name' => 'NPL Friday Standard',
            'from_tournament_id' => $original['session']['id'],
            'is_default' => true,
        ]);

        $this->assertTrue($template['is_default']);
        $this->assertSame(3, $template['level_count']);
        $this->assertSame(30000, $template['settings']['starting_stack']);

        // Next week: name only — everything else comes from the template.
        $nextWeek = $service->create(['name' => 'Friday Deepstack (2 Aug)', 'registration_closes_at_level' => 1]);

        $this->assertSame(30000, $nextWeek['session']['starting_stack']);
        $this->assertSame(5500, $nextWeek['session']['rebuy_price_cents']);
        $this->assertSame(2, $nextWeek['session']['max_addons_per_player']);
        $this->assertCount(3, $nextWeek['levels']);
        $this->assertSame(25, $nextWeek['levels'][0]['duration_min']);

        // Usage is tracked so the busiest preset can float to the top.
        $this->assertSame(1, $templates->find($template['id'])['times_used']);
    }

    public function test_an_explicit_value_still_beats_the_template(): void
    {
        $templates = app(TournamentTemplateService::class);
        $service = app(TournamentService::class);

        $templates->save([
            'name' => 'House Default',
            'is_default' => true,
            'settings' => ['starting_stack' => 20000, 'buy_in_price_cents' => 10000, 'registration_closes_at_level' => 1],
            'levels' => [['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20]],
        ]);

        // A one-off with a bigger stack — the preset is a starting point.
        $tonight = $service->create(['name' => 'Charity Night', 'starting_stack' => 99000]);

        $this->assertSame(99000, $tonight['session']['starting_stack']);
        $this->assertSame(10000, $tonight['session']['buy_in_price_cents'], 'Untouched settings still come from the template.');
    }

    public function test_only_one_template_can_be_the_default(): void
    {
        $templates = app(TournamentTemplateService::class);

        $first = $templates->save([
            'name' => 'Old Default', 'is_default' => true,
            'settings' => ['starting_stack' => 10000],
            'levels' => [['type' => 'blind', 'small_blind' => 50, 'big_blind' => 100, 'duration_min' => 15]],
        ]);
        $second = $templates->save([
            'name' => 'New Default', 'is_default' => true,
            'settings' => ['starting_stack' => 20000],
            'levels' => [['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20]],
        ]);

        $this->assertFalse($templates->find($first['id'])['is_default']);
        $this->assertTrue($templates->find($second['id'])['is_default']);
        $this->assertSame('New Default', $templates->default()['name']);
    }

    public function test_templates_are_managed_over_the_api(): void
    {
        $this->postJson('/api/v1/tournament-templates', [
            'name' => 'Turbo',
            'description' => 'Fast weekly',
            'is_default' => true,
            'settings' => ['starting_stack' => 12000],
            'levels' => [['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 10]],
        ])->assertStatus(201)->assertJsonPath('data.template.name', 'Turbo');

        $body = $this->getJson('/api/v1/tournament-templates')->assertOk()->json('data');
        $this->assertCount(1, $body['templates']);
        $this->assertSame('Turbo', $body['default']['name']);

        // Creating from a template id, over HTTP.
        $created = $this->postJson('/api/v1/tournaments', [
            'registration_closes_at_level' => 1,
            'name' => 'Tonight',
            'template_id' => $body['templates'][0]['id'],
        ])->assertStatus(201)->json('data');

        $this->assertSame(12000, $created['session']['starting_stack']);
        $this->assertSame(10, $created['levels'][0]['duration_min']);

        $this->deleteJson('/api/v1/tournament-templates/'.$body['templates'][0]['id'])->assertOk();
        $this->assertSame([], $this->getJson('/api/v1/tournament-templates')->json('data.templates'));
    }

    public function test_the_broadcast_command_publishes_every_live_tournament(): void
    {
        $service = app(TournamentService::class);
        $clock = app(TournamentClockService::class);

        $a = $service->create(['name' => 'Live A', 'registration_closes_at_level' => 1]);
        $service->create(['name' => 'Draft B', 'registration_closes_at_level' => 1]);
        $clock->start($a['session']['id']);

        // No licence in tests, so publishing is a no-op — but the command must
        // still find exactly the live tournaments and exit cleanly.
        $this->artisan('tournament:broadcast')
            ->expectsOutputToContain('of 1 live tournament(s)')
            ->assertSuccessful();
    }
}
