<?php

namespace Tests\Feature;

use App\Services\Tournament\BlindStructureGenerator;
use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentDeskService;
use App\Services\Tournament\TournamentGateService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class TournamentDeskTest extends TestCase
{
    use RefreshDatabase;

    private function tournament(array $overrides = []): int
    {
        $result = app(TournamentService::class)->create(array_merge([
            'name' => 'Thursday Deepstack',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'starting_stack' => 20000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'addon_chips' => 30000,
            'addon_price_cents' => 5000,
            'max_addons_per_player' => 1,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 3,
            'jackpot_enabled' => true,
            'jackpot_price_cents' => 1000,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['level_no' => 2, 'type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
                ['level_no' => 3, 'type' => 'blind', 'small_blind' => 300, 'big_blind' => 600, 'duration_min' => 20],
                ['level_no' => 4, 'type' => 'blind', 'small_blind' => 500, 'big_blind' => 1000, 'duration_min' => 20],
                ['level_no' => 5, 'type' => 'blind', 'small_blind' => 800, 'big_blind' => 1600, 'duration_min' => 20],
            ],
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

    private function advanceToLevel(int $id, int $index): void
    {
        app(TournamentClockService::class)->start($id);

        for ($i = 0; $i < $index; $i++) {
            app(TournamentClockService::class)->nextLevel($id);
        }
    }

    // ---------------------------------------------------------------- scan --

    public function test_scanning_an_unknown_id_tells_the_desk_to_sync(): void
    {
        $id = $this->tournament();

        $this->expectException(ValidationException::class);
        app(TournamentDeskService::class)->scan($id, 'NPL999999');
    }

    public function test_a_scan_charges_nothing_and_returns_the_options(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL1001', 'Ace Nguyen');

        $result = app(TournamentDeskService::class)->scan($id, 'npl1001');

        $this->assertSame('NPL1001', $result['player']['npl_id']);
        $this->assertSame('Ace Nguyen', $result['player']['display_name']);
        $this->assertNull($result['entry']);

        // Nothing was recorded by looking someone up.
        $this->assertSame(0, DB::table('tournament_actions')->count());

        $byAction = collect($result['options'])->keyBy('action');
        $this->assertTrue($byAction['buy_in']['allowed']);
        $this->assertSame(10000, $byAction['buy_in']['price_cents']);
        // Not in the field yet, so nothing else is available.
        $this->assertFalse($byAction['rebuy']['allowed']);
        $this->assertFalse($byAction['addon']['allowed']);
    }

    public function test_scanner_whitespace_and_case_are_normalised(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL1001');

        $result = app(TournamentDeskService::class)->scan($id, "  npl 1001 \r\n");

        $this->assertSame('NPL1001', $result['player']['npl_id']);
    }

    // ------------------------------------------------------------ cut-offs --

    public function test_past_the_registration_cut_off_a_new_player_is_refused(): void
    {
        $id = $this->tournament(['registration_closes_at_level' => 2]);
        $this->mirrorPlayer('NPL2001');
        $this->advanceToLevel($id, 2);

        $scan = app(TournamentDeskService::class)->scan($id, 'NPL2001');
        $buyIn = collect($scan['options'])->firstWhere('action', 'buy_in');

        $this->assertFalse($buyIn['allowed']);
        $this->assertStringContainsString('closed', strtolower((string) $buyIn['reason']));

        $this->expectException(ValidationException::class);
        app(TournamentDeskService::class)->apply($id, 'NPL2001', 'buy_in');
    }

    public function test_an_existing_player_can_still_rebuy_after_registration_closes(): void
    {
        // Registration shuts at level 2, but rebuys run to level 4.
        $id = $this->tournament([
            'registration_closes_at_level' => 2,
            'rebuy_closes_at_level' => 4,
        ]);
        $this->mirrorPlayer('NPL3001');

        app(TournamentDeskService::class)->apply($id, 'NPL3001', 'buy_in');
        $this->advanceToLevel($id, 2);

        $scan = app(TournamentDeskService::class)->scan($id, 'NPL3001');
        $options = collect($scan['options'])->keyBy('action');

        $this->assertFalse($options['buy_in']['allowed'], 'No new entries past the cut-off.');
        $this->assertTrue($options['rebuy']['allowed'], 'A player already in the field may still rebuy.');

        app(TournamentDeskService::class)->apply($id, 'NPL3001', 'rebuy');
        $this->assertSame(1, DB::table('tournament_actions')->where('action', 'rebuy')->count());
    }

    public function test_an_optional_cut_off_only_bites_when_it_is_set(): void
    {
        // No add-on cut-off: add-ons stay open at a level where registration
        // has already closed.
        $id = $this->tournament(['registration_closes_at_level' => 2]);
        $this->mirrorPlayer('NPL3101');
        app(TournamentDeskService::class)->apply($id, 'NPL3101', 'buy_in');
        $this->advanceToLevel($id, 3);

        $gates = app(TournamentGateService::class)->gates($id);
        $this->assertFalse($gates['registration']['open']);
        $this->assertTrue($gates['addon']['open']);
        $this->assertNull($gates['addon']['closes_at_level']);
    }

    public function test_every_cut_off_is_independent_and_blank_means_open_until_the_end(): void
    {
        $id = $this->tournament(['registration_closes_at_level' => 2]);
        $gates = app(TournamentGateService::class)->gates($id);

        // Rebuy and jackpot no longer inherit the registration cut-off —
        // blank means open until the tournament finishes.
        $this->assertNull($gates['rebuy']['closes_at_level']);
        $this->assertNull($gates['jackpot']['closes_at_level']);
        $this->assertTrue($gates['rebuy']['open']);
    }

    public function test_a_cut_off_beyond_the_structure_is_rejected(): void
    {
        $this->expectException(ValidationException::class);
        $this->tournament(['registration_closes_at_level' => 40]);
    }

    public function test_the_countdown_to_a_cut_off_spans_the_levels_in_between(): void
    {
        $id = $this->tournament(['registration_closes_at_level' => 3]);
        app(TournamentClockService::class)->start($id);

        $gates = app(TournamentGateService::class)->gates($id);

        // Level 1 has just started (20 min), then levels 2 and 3 are another
        // 20 each — registration shuts as level 3 (index 3) begins.
        $this->assertGreaterThan(59 * 60_000, $gates['registration']['closes_in_ms']);
        $this->assertLessThanOrEqual(60 * 60_000, $gates['registration']['closes_in_ms']);
    }

    // ---------------------------------------------------------------- caps --

    public function test_the_add_on_cap_is_enforced_and_surfaced_on_the_scan(): void
    {
        $id = $this->tournament(['max_addons_per_player' => 1]);
        $this->mirrorPlayer('NPL4001');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL4001', 'buy_in');
        $desk->apply($id, 'NPL4001', 'addon');

        $scan = $desk->scan($id, 'NPL4001');
        $addon = collect($scan['options'])->firstWhere('action', 'addon');

        $this->assertFalse($addon['allowed']);
        $this->assertStringContainsString('All 1 add-on', $addon['reason']);
    }

    // --------------------------------------------------------- elimination --

    public function test_eliminating_a_player_frees_the_seat_but_keeps_the_record(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL5001');
        $this->mirrorPlayer('NPL5002');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL5001', 'buy_in', ['table_number' => 1, 'seat_number' => 1]);
        $desk->apply($id, 'NPL5002', 'buy_in', ['table_number' => 1, 'seat_number' => 2]);

        $seating = $desk->eliminate($id, 'NPL5001');

        // Gone from the table…
        $seatOne = collect($seating['tables'][0]['seats'])->firstWhere('seat_number', 1);
        $this->assertNull($seatOne['player']);

        // …but still in the record, with a finishing position.
        $this->assertCount(1, $seating['eliminated']);
        $this->assertSame('NPL5001', $seating['eliminated'][0]['npl_id']);
        $this->assertSame(2, $seating['eliminated'][0]['finish_position']);
        $this->assertSame(1, $seating['counts']['active']);

        // And the ledger records the knockout.
        $this->assertSame(1, DB::table('tournament_actions')->where('action', 'ko')->count());
    }

    public function test_a_rebuy_brings_an_eliminated_player_back(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL6001');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL6001', 'buy_in', ['table_number' => 1, 'seat_number' => 3]);
        $desk->eliminate($id, 'NPL6001');
        $desk->apply($id, 'NPL6001', 'rebuy');

        $entry = DB::table('tournament_entries')->where('player_npl_id', 'NPL6001')->first();

        $this->assertSame('active', $entry->status);
        $this->assertNull($entry->eliminated_at);
        $this->assertNull($entry->finish_position);
    }

    public function test_a_busted_player_cannot_be_eliminated_twice(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL6101');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL6101', 'buy_in');
        $desk->eliminate($id, 'NPL6101');

        $this->expectException(ValidationException::class);
        $desk->eliminate($id, 'NPL6101');
    }

    // ------------------------------------------------------------- jackpot --

    public function test_joining_the_jackpot_records_locally_and_queues_for_the_cloud(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7001');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL7001', 'buy_in');
        $result = $desk->apply($id, 'NPL7001', 'jackpot');

        $this->assertTrue($result['jackpot']['joined']);
        $this->assertSame(1000, $result['jackpot']['amount_cents']);

        $this->assertTrue((bool) DB::table('tournament_entries')
            ->where('player_npl_id', 'NPL7001')
            ->value('in_jackpot'));

        // Queued rather than posted inline, so a dropped connection at the
        // venue does not lose the entry.
        $queued = DB::table('sync_outbox')->where('entity_type', 'jackpot_entry')->first();
        $this->assertNotNull($queued);
        $payload = json_decode((string) $queued->payload, true);
        $this->assertSame('NPL7001', $payload['player_npl_id']);
        $this->assertSame(1000, $payload['amount_cents']);
    }

    public function test_a_player_cannot_join_the_jackpot_twice(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7101');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL7101', 'buy_in');
        $desk->apply($id, 'NPL7101', 'jackpot');

        $scan = $desk->scan($id, 'NPL7101');
        $jackpot = collect($scan['options'])->firstWhere('action', 'jackpot');
        $this->assertFalse($jackpot['allowed']);

        $this->expectException(ValidationException::class);
        $desk->apply($id, 'NPL7101', 'jackpot');
    }

    public function test_the_jackpot_option_is_hidden_when_it_is_not_running(): void
    {
        $id = $this->tournament(['jackpot_enabled' => false]);
        $this->mirrorPlayer('NPL7201');

        $scan = app(TournamentDeskService::class)->scan($id, 'NPL7201');

        $this->assertNull(collect($scan['options'])->firstWhere('action', 'jackpot'));
    }

    // ---------------------------------------------------------- cash game --

    public function test_a_cash_game_opens_without_levels_and_finishes_without_standings(): void
    {
        $result = app(TournamentService::class)->create([
            'game_type' => 'cash',
            'venue_name' => 'St George Club',
            'venue_id' => 7,
            'buy_in_price_cents' => 10000,
            'starting_stack' => 10000,
            'rebuy_tiers' => [['price_cents' => 10000, 'chips' => 10000]],
            'max_rebuys_per_player' => 255,
            'seats_per_table' => 8,
        ]);

        $id = (int) $result['session']['id'];
        $this->assertSame('cash', $result['session']['game_type']);
        $this->assertNull($result['session']['registration_closes_at_level']);

        // Buy-in seats, top-ups work, and nothing ever cuts off — no clock
        // was ever started.
        $this->mirrorPlayer('NPL9001');
        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL9001', 'buy_in');
        $desk->apply($id, 'NPL9001', 'rebuy');

        $gates = app(TournamentGateService::class)->gates($id);
        $this->assertTrue($gates['registration']['open']);
        $this->assertNull($gates['registration']['closes_at_level']);
        $this->assertTrue($gates['rebuy']['open']);

        // Finishing with zero placements closes the game — cash records no
        // standings.
        $finish = $desk->finishWithResults($id, []);
        $this->assertSame(0, $finish['recorded']);
        $this->assertSame('finished', DB::table('tournament_sessions')->where('id', $id)->value('status'));
    }

    // ------------------------------------------------------------- seating --

    public function test_players_without_a_club_membership_are_flagged_once_the_register_has_data(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7601');
        $this->mirrorPlayer('NPL7602');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL7601', 'buy_in');
        $desk->apply($id, 'NPL7602', 'buy_in');

        // No register mirrored yet: no data, nobody gets shouted at.
        $players = collect($desk->seating($id)['tables'][0]['seats'])->pluck('player')->filter();
        $this->assertNull($players->firstWhere('npl_id', 'NPL7601')['club_member']);

        DB::table('mirror_club_memberships')->insert([
            'cloud_id' => 1,
            'venue_id' => 7,
            'npl_id' => 'npl7601',
            'club_member_code' => 'STG-0001',
            'status' => 'active',
            'valid' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Case-insensitive holder passes; the other player gets the flag.
        // Fresh service: the register cache is per-request in production.
        $desk = app(TournamentDeskService::class);
        $players = collect($desk->seating($id)['tables'][0]['seats'])->pluck('player')->filter();
        $this->assertTrue($players->firstWhere('npl_id', 'NPL7601')['club_member']);
        $this->assertFalse($players->firstWhere('npl_id', 'NPL7602')['club_member']);
    }

    public function test_tables_hold_eight_seats_and_a_taken_seat_is_refused(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL8001');
        $this->mirrorPlayer('NPL8002');

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL8001', 'buy_in', ['table_number' => 1, 'seat_number' => 4]);
        $desk->apply($id, 'NPL8002', 'buy_in');

        $seating = $desk->seating($id);
        $this->assertSame(8, $seating['seats_per_table']);
        $this->assertCount(8, $seating['tables'][0]['seats']);

        // Buy-in auto-seats now: the second player landed in a free seat
        // instead of the unseated pool.
        $this->assertCount(0, $seating['unseated']);
        $second = collect($seating['tables'][0]['seats'])
            ->first(fn (array $seat): bool => ($seat['player']['npl_id'] ?? null) === 'NPL8002');
        $this->assertNotNull($second);

        $this->expectException(ValidationException::class);
        $desk->seat($id, 'NPL8002', 1, 4);
    }

    public function test_buy_in_auto_seat_keeps_blocked_players_on_different_tables(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL8201');
        $this->mirrorPlayer('NPL8202');

        DB::table('mirror_player_relationships')->insert([
            'cloud_id' => 1,
            'player_id' => crc32('NPL8201'),
            'related_player_id' => crc32('NPL8202'),
            'type' => 'blocked',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $desk = app(TournamentDeskService::class);
        $desk->apply($id, 'NPL8201', 'buy_in');
        $desk->apply($id, 'NPL8202', 'buy_in');

        $tableOf = function (array $seating, string $nplId): ?int {
            foreach ($seating['tables'] as $table) {
                foreach ($table['seats'] as $seat) {
                    if (($seat['player']['npl_id'] ?? null) === $nplId) {
                        return (int) $table['table_number'];
                    }
                }
            }

            return null;
        };

        $seating = $desk->seating($id);
        $first = $tableOf($seating, 'NPL8201');
        $second = $tableOf($seating, 'NPL8202');

        $this->assertNotNull($first);
        $this->assertNotNull($second);
        $this->assertNotSame($first, $second, 'Blocked players must not be auto-seated at the same table.');
    }

    public function test_a_seat_outside_the_table_size_is_refused(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL8101');
        app(TournamentDeskService::class)->apply($id, 'NPL8101', 'buy_in');

        $this->expectException(ValidationException::class);
        app(TournamentDeskService::class)->seat($id, 'NPL8101', 1, 9);
    }

    // --------------------------------------------------- structure builder --

    public function test_the_generator_multiplies_blinds_and_inserts_breaks(): void
    {
        $levels = app(BlindStructureGenerator::class)->generate([
            'levels' => 6,
            'duration_min' => 20,
            'small_blind' => 100,
            'mode' => 'multiply',
            'step' => 2.0,
            'break_every' => 3,
        ]);

        $blinds = array_values(array_filter($levels, fn (array $l): bool => $l['type'] === 'blind'));
        $this->assertCount(6, $blinds);
        $this->assertSame(100, $blinds[0]['small_blind']);
        $this->assertSame(200, $blinds[0]['big_blind']);
        $this->assertSame(200, $blinds[1]['small_blind']);
        $this->assertSame(400, $blinds[2]['small_blind']);

        // One break after level 3; none trailing the final level.
        $breaks = array_values(array_filter($levels, fn (array $l): bool => $l['type'] === 'break'));
        $this->assertCount(1, $breaks);
        $this->assertSame('break', $levels[3]['type']);
    }

    public function test_the_generator_adds_a_flat_step_when_asked(): void
    {
        $levels = app(BlindStructureGenerator::class)->generate([
            'levels' => 4,
            'small_blind' => 500,
            'mode' => 'add',
            'step' => 500,
            'break_every' => 0,
        ]);

        $this->assertSame([500, 1000, 1500, 2000], array_column($levels, 'small_blind'));
    }

    public function test_generated_blinds_round_to_payable_amounts(): void
    {
        $levels = app(BlindStructureGenerator::class)->generate([
            'levels' => 6,
            'small_blind' => 100,
            'mode' => 'multiply',
            'step' => 1.5,
            'break_every' => 0,
        ]);

        foreach ($levels as $level) {
            $this->assertSame(
                0,
                $level['small_blind'] % 25,
                'A dealer has to be able to make change for '.$level['small_blind'],
            );
        }
    }

    public function test_big_blind_antes_start_at_the_requested_level(): void
    {
        $levels = app(BlindStructureGenerator::class)->generate([
            'levels' => 4,
            'small_blind' => 100,
            'ante_from_level' => 3,
            'break_every' => 0,
        ]);

        $this->assertSame(0, $levels[0]['bb_ante']);
        $this->assertSame(0, $levels[1]['bb_ante']);
        $this->assertSame($levels[2]['big_blind'], $levels[2]['bb_ante']);
    }

    // ------------------------------------------------------------ display --

    public function test_the_chips_prize_rail_survives_the_http_layer_and_updates_mid_game(): void
    {
        // Through HTTP on purpose: request validation once silently dropped
        // `settings`, so rail text typed at prep never reached the room clock.
        $id = (int) $this->postJson('/api/v1/tournaments', [
            'name' => 'Rail Night',
            'starting_stack' => 20000,
            'registration_closes_at_level' => 2,
            'settings' => [
                'chip_denominations' => "Green 25\nBlack 100",
                'prize_pool_text' => 'Prize pool $2,000',
            ],
            'levels' => [
                ['type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
                ['type' => 'blind', 'small_blind' => 200, 'big_blind' => 400, 'duration_min' => 20],
            ],
        ])->assertStatus(201)->json('data.session.id');

        $display = $this->getJson("/api/v1/desk/{$id}/seating")->assertOk()->json('data.display');
        $this->assertSame("Green 25\nBlack 100", $display['chip_denominations']);
        $this->assertSame('Prize pool $2,000', $display['prize_pool_text']);

        // A draft edit reworks one line...
        $this->putJson("/api/v1/tournaments/{$id}", [
            'settings' => ['chip_denominations' => "Green 25\nBlack 100\nPurple 500"],
        ])->assertOk();

        $display = $this->getJson("/api/v1/desk/{$id}/seating")->assertOk()->json('data.display');
        $this->assertSame("Green 25\nBlack 100\nPurple 500", $display['chip_denominations']);
        // ...without wiping the other (the settings bag merges, never replaces).
        $this->assertSame('Prize pool $2,000', $display['prize_pool_text']);

        // Once running the full settings edit stays locked, but the rail
        // stays live — the prize pool grows with every rebuy.
        app(TournamentClockService::class)->start($id);

        $this->putJson("/api/v1/tournaments/{$id}", [
            'settings' => ['prize_pool_text' => 'nope'],
        ])->assertStatus(422);

        $this->putJson("/api/v1/tournaments/{$id}/display", [
            'prize_pool_text' => 'Prize pool $2,600',
        ])->assertOk();

        $display = $this->getJson("/api/v1/desk/{$id}/seating")->assertOk()->json('data.display');
        $this->assertSame('Prize pool $2,600', $display['prize_pool_text']);
        $this->assertSame("Green 25\nBlack 100\nPurple 500", $display['chip_denominations']);
    }

    // ----------------------------------------------------------- admin qr --

    public function test_the_admin_qr_carries_the_broadcast_identity(): void
    {
        $id = $this->tournament(['game_session_id' => 555]);

        $qr = $this->getJson("/api/v1/tournaments/{$id}/admin-qr")->assertOk()->json('data.qr');

        $this->assertSame(555, $qr['game_session_id']);
        $this->assertSame('Thursday Deepstack', $qr['name']);
        $this->assertSame('St George Club', $qr['venue_name']);

        // The uid must be EXACTLY what the clock broadcasts to the cloud —
        // the broadcaster's rule, not a re-derivation.
        $uuid = (string) DB::table('tournament_sessions')->where('id', $id)->value('uuid');
        $device = app(\App\Services\Cloud\LicenseKeyProvider::class)->deviceId() ?: 'unknown';
        $this->assertSame(sprintf('npl:%s:%s', $device, substr($uuid, 0, 8)), $qr['tournament_uid']);
    }
}
