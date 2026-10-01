<?php

namespace Tests\Feature;

use App\Services\Printing\ReceiptService;
use App\Services\Tournament\TournamentClockService;
use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The money paper trail: every buy-in, rebuy, add-on and jackpot entry
 * prints a silent receipt through the Go host's raw-print bridge — with
 * the venue's own header/footer words and the player's table + seat.
 * Printing is a status, never a blocker: a dead printer still sells.
 */
class ReceiptPrintingTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        config(['nplcloud.host_bridge' => 'http://127.0.0.1:8788']);
    }

    private function tournament(array $overrides = []): int
    {
        $result = app(TournamentService::class)->create(array_merge([
            'name' => 'Thursday Deepstack',
            'venue_name' => 'St George Club',
            'starting_stack' => 20000,
            'rebuy_chips' => 20000,
            'rebuy_price_cents' => 5000,
            'max_rebuys_per_player' => 2,
            'buy_in_price_cents' => 10000,
            'registration_closes_at_level' => 1,
            'seats_per_table' => 8,
            'levels' => [
                ['level_no' => 1, 'type' => 'blind', 'small_blind' => 100, 'big_blind' => 200, 'duration_min' => 20],
            ],
        ], $overrides));

        $id = (int) $result['session']['id'];

        // The jackpot switches live on the session row.
        DB::table('tournament_sessions')->where('id', $id)->update([
            'jackpot_enabled' => true,
            'jackpot_price_cents' => 500,
        ]);

        return $id;
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

    private function fakeBridge(): void
    {
        Http::fake([
            '*/api/print/receipt' => Http::response(['ok' => true]),
            '*' => Http::response(['ok' => true, 'data' => ['tournament' => [], 'broadcast' => false]]),
        ]);
    }

    /** @return list<array<string, mixed>> */
    private function lastReceiptLines(): array
    {
        $requests = Http::recorded(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt'));
        $this->assertNotEmpty($requests, 'The receipt must reach the host print bridge.');

        return $requests->last()[0]->data()['lines'];
    }

    private function lastReceiptText(): string
    {
        return implode("\n", array_column($this->lastReceiptLines(), 'text'));
    }

    private function linkScheduledGame(int $id, array $payload = [], ?string $startTime = '18:30:00'): void
    {
        DB::table('mirror_game_sessions')->insert([
            'session_id' => 9001,
            'source_type' => 'daily_game',
            'venue_id' => 91,
            'venue_name' => 'St George Club',
            'title' => 'Thursday Deepstack',
            'session_date' => '2026-09-24',
            'start_time' => $startTime,
            'payload' => json_encode($payload),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        DB::table('tournament_sessions')->where('id', $id)->update(['game_session_id' => 9001, 'venue_id' => 91]);
    }

    private function printRecordedAction(int $id, string $nplId, string $action = 'buy_in', array $options = []): string
    {
        return app(ReceiptService::class)->printAction(
            $id,
            DB::table('tournament_sessions')->where('id', $id)->first(),
            $nplId,
            $action,
            $options,
        );
    }

    public function test_a_desk_buy_in_prints_with_table_seat_and_custom_words(): void
    {
        DB::table('receipt_settings')->insert([
            'enabled' => true,
            'printer_name' => 'EPSON TM-T82',
            'header_text' => "NPL POKER SYDNEY\nOfficial receipt",
            'footer_text' => 'See you Friday!',
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $id = $this->tournament();
        $this->mirrorPlayer('NPL7001', 'Alex Chen');
        $this->fakeBridge();

        $response = $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7001',
            'action' => 'buy_in',
        ])->assertOk();

        $this->assertSame('printed', $response->json('data.result.receipt'));

        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString('NPL POKER SYDNEY', $receipt);
        $this->assertStringContainsString('BUY-IN', $receipt);
        $this->assertStringContainsString('Alex Chen', $receipt);
        $this->assertStringContainsString("TABLE 1\nSEAT 1\nAlex Chen", $receipt);
        $this->assertStringContainsString("BUY-IN\n$100.00\nChips: 20,000", $receipt);
        $this->assertStringContainsString('See you Friday!', $receipt);

        $lines = $this->lastReceiptLines();
        $this->assertSame(['text' => 'NPL', 'logo' => true, 'center' => true], $lines[0]);
        foreach (['TABLE 1', 'SEAT 1', 'Alex Chen', '$100.00'] as $largeText) {
            $this->assertContains(['text' => $largeText, 'center' => true, 'bold' => true, 'big' => true], $lines);
        }
        $this->assertCount(2, array_filter($lines, fn (array $line): bool => $line['divider'] ?? false));
        $this->assertStringContainsString("St George Club\nThursday Deepstack\nGuaranteed: Not specified", $receipt);
        $this->assertStringContainsString('Printed ', $receipt);
        $this->assertStringContainsString("npl.com.au\nSee you Friday!", $receipt);

        // The named printer rides the print job.
        Http::assertSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt')
            && ($request->data()['printer'] ?? null) === 'EPSON TM-T82');
    }

    public function test_a_jackpot_entry_prints_its_own_receipt(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7002', 'Sam Fold');
        $this->fakeBridge();

        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7002',
            'action' => 'buy_in',
        ])->assertOk();

        // The jackpot rides the same submit as the first buy-in, so the
        // popup sends the batch flag with it.
        $response = $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7002',
            'action' => 'jackpot',
            'first_buy_in' => true,
        ])->assertOk();

        $this->assertSame('printed', $response->json('data.result.receipt'));
        $this->assertStringContainsString('JACKPOT ENTRY', $this->lastReceiptText());
        $this->assertStringContainsString("JACKPOT ENTRY\n$5.00\nChips: 0", $this->lastReceiptText());
    }

    public function test_a_ticket_stack_prints_the_tickets_and_the_deficit(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7003', 'Kim Stack');
        $this->fakeBridge();

        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7003',
            'action' => 'buy_in',
            'voucher_codes' => ['STAAAA1111', 'STBBBB2222'],
            'voucher_covered_cents' => 4000,
        ])->assertOk();

        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("Entry fee: $100.00\nTicket: STAAAA1111\nTicket: STBBBB2222\nTickets cover: $40.00\nPaid at desk: $60.00", $receipt);
        $this->assertStringContainsString("BUY-IN\n$60.00", $receipt);
    }

    public function test_main_event_payment_uses_cloud_fee_and_prints_each_ticket_snapshot(): void
    {
        $id = $this->tournament(['buy_in_price_cents' => 10000]);
        $this->mirrorPlayer('NPL7020', 'Main Event Player');
        $this->fakeBridge();
        $payload = [
            'player_npl_id' => 'NPL7020', 'action' => 'buy_in', 'idempotency_key' => 'main:flight1',
            'voucher_codes' => ['TICKET1', 'TICKET2'],
            'voucher_covered_cents' => 50000, 'voucher_entry_fee_cents' => 75000, 'voucher_deficit_cents' => 25000,
            'voucher_tickets' => [['code' => 'TICKET1', 'value_cents' => 25000], ['code' => 'TICKET2', 'value_cents' => 25000]],
        ];
        $this->postJson("/api/v1/desk/{$id}/act", $payload)->assertOk()->assertJsonPath('data.result.charged_cents', 25000);
        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("BUY-IN\n$250.00", $receipt);
        $this->assertStringContainsString("Entry fee: $750.00\nTicket: TICKET1 $250.00\nTicket: TICKET2 $250.00\nTickets cover: $500.00\nPaid at desk: $250.00", $receipt);
        $this->postJson("/api/v1/desk/{$id}/act", $payload)->assertOk()->assertJsonPath('data.result.replayed', true)->assertJsonPath('data.result.charged_cents', 25000);
        $this->assertCount(1, Http::recorded(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt')));
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public function test_main_event_three_tickets_cover_entry_and_another_flight_is_separate(): void
    {
        $this->mirrorPlayer('NPL7021', 'Multi Flight Player');
        $this->fakeBridge();
        foreach ([1, 2] as $flight) {
            $id = $this->tournament(['buy_in_price_cents' => 10000]);
            $codes = ["F{$flight}T1", "F{$flight}T2", "F{$flight}T3"];
            $this->postJson("/api/v1/desk/{$id}/act", [
                'player_npl_id' => 'NPL7021', 'action' => 'buy_in', 'idempotency_key' => "flight:{$flight}",
                'voucher_codes' => $codes, 'voucher_covered_cents' => 75000,
                'voucher_entry_fee_cents' => 75000, 'voucher_deficit_cents' => 0,
                'voucher_tickets' => array_map(fn ($code): array => ['code' => $code, 'value_cents' => 25000], $codes),
            ])->assertOk();
            $this->assertStringContainsString("BUY-IN\n$0.00", $this->lastReceiptText());
            $this->assertStringContainsString("Ticket: F{$flight}T3 $250.00", $this->lastReceiptText());
            DB::table('tournament_sessions')->where('id', $id)->update(['status' => 'finished', 'finished_at' => now()]);
        }
        $this->assertDatabaseCount('tournament_entries', 2);
        $this->assertDatabaseCount('tournament_actions', 2);
    }

    public function test_more_than_ten_tickets_reach_the_ledger_and_receipt_without_truncating_codes(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7022', 'Many Tickets');
        $this->fakeBridge();
        $codes = array_map(fn ($i): string => sprintf('ST%08d', $i), range(1, 12));
        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7022', 'action' => 'buy_in',
            'voucher_codes' => $codes, 'voucher_covered_cents' => 12000,
            'voucher_entry_fee_cents' => 12000, 'voucher_deficit_cents' => 0,
            'voucher_tickets' => array_map(fn ($code): array => ['code' => $code, 'value_cents' => 1000], $codes),
        ])->assertOk();
        foreach ($codes as $code) {
            $this->assertContains("Ticket: {$code} $10.00", array_column($this->lastReceiptLines(), 'text'));
        }
    }

    public function test_a_buy_in_reference_cannot_be_reused_in_another_flight(): void
    {
        $this->mirrorPlayer('NPL7024', 'Reference Owner');
        $this->fakeBridge();
        $first = $this->tournament();
        $this->postJson("/api/v1/desk/{$first}/act", [
            'player_npl_id' => 'NPL7024', 'action' => 'buy_in', 'idempotency_key' => 'SAME-REFERENCE',
        ])->assertOk();
        DB::table('tournament_sessions')->where('id', $first)->update(['status' => 'finished', 'finished_at' => now()]);
        $second = $this->tournament();
        $this->postJson("/api/v1/desk/{$second}/act", [
            'player_npl_id' => 'NPL7024', 'action' => 'buy_in', 'idempotency_key' => 'SAME-REFERENCE',
        ])->assertUnprocessable();
        $this->assertDatabaseMissing('tournament_entries', ['tournament_session_id' => $second]);
        $this->assertDatabaseCount('tournament_actions', 1);
    }

    public function test_an_ordinary_main_event_free_voucher_does_not_print_a_zero_value_ticket(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7025', 'Free Entry Player');
        $this->fakeBridge();
        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7025', 'action' => 'buy_in',
            'voucher_codes' => ['FREE-ENTRY'], 'voucher_covered_cents' => 75000,
            'voucher_entry_fee_cents' => 75000, 'voucher_deficit_cents' => 0,
            'voucher_tickets' => [['code' => 'FREE-ENTRY', 'value_cents' => 0, 'type' => 'game_entry']],
        ])->assertOk();
        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("Voucher: FREE-ENTRY\nVouchers cover: $750.00", $receipt);
        $this->assertStringNotContainsString('FREE-ENTRY $0.00', $receipt);
        $this->assertStringContainsString("BUY-IN\n$0.00", $receipt);
    }

    public function test_inconsistent_confirmed_ticket_totals_do_not_record_or_print_a_sale(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7023', 'Invalid Payment');
        $this->fakeBridge();
        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7023', 'action' => 'buy_in',
            'voucher_codes' => ['TICKET1'], 'voucher_covered_cents' => 25000,
            'voucher_entry_fee_cents' => 75000, 'voucher_deficit_cents' => 0,
        ])->assertUnprocessable();
        $this->assertDatabaseCount('tournament_entries', 0);
        $this->assertDatabaseCount('tournament_actions', 0);
        Http::assertNotSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt'));
    }

    public function test_a_fully_covered_phone_buy_in_keeps_the_zero_amount_and_voucher_details(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7010', 'Voucher Player');
        $this->fakeBridge();

        $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7010',
            'action' => 'buy_in',
            'idempotency_key' => 'tsr:7010',
            'voucher_code' => 'FREEENTRY',
        ])->assertOk()->assertJsonPath('data.result.receipt', 'printed');

        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("BUY-IN\n$0.00\nChips: 20,000", $receipt);
        $this->assertStringContainsString('Voucher: FREEENTRY ($100.00 covered)', $receipt);
        $this->assertDatabaseHas('tournament_actions', [
            'player_npl_id' => 'NPL7010', 'action' => 'buy_in', 'price_cents' => 0,
        ]);
    }

    public function test_the_scheduled_date_and_exact_guarantee_print_without_a_payout_ladder(): void
    {
        $id = $this->tournament();
        $this->linkScheduledGame($id, [
            'guarantee' => '$2K GTD',
            // A championship session can override the displayed guarantee
            // while its event-wide numeric amount remains in the payload.
            'guaranteed_prize_cents' => 1000000,
            'prize_breakdown' => null,
        ]);
        app(TournamentService::class)->register($id, 'NPL7011', 'Scheduled Player', 7, 4);
        $this->fakeBridge();

        $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7011'));
        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("NPL\n24/09/2026 6:30 PM\nSt George Club\nThursday Deepstack\nGuaranteed: $2K GTD", $receipt);
        $this->assertStringContainsString("TABLE 7\nSEAT 4", $receipt);
        $this->assertStringNotContainsString('$10,000', $receipt);
    }

    public function test_a_schedule_without_start_time_does_not_invent_midnight_or_a_guarantee(): void
    {
        $id = $this->tournament();
        $this->linkScheduledGame($id, ['prize_breakdown' => [['place' => '1st', 'prize' => '$500']]], null);
        app(TournamentService::class)->register($id, 'NPL7012', 'Date Only');
        $this->fakeBridge();

        $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7012'));
        $lines = $this->lastReceiptLines();
        $this->assertSame('24/09/2026', $lines[1]['text']);
        $this->assertStringContainsString('Guaranteed: Not specified', $this->lastReceiptText());
        $this->assertStringNotContainsString('Guaranteed: $500', $this->lastReceiptText());
        $this->assertStringContainsString("TABLE UNASSIGNED\nSEAT UNASSIGNED", $this->lastReceiptText());
    }

    public function test_print_time_is_delegated_to_the_laptop_even_when_server_and_venue_clocks_differ(): void
    {
        $this->travelTo(Carbon::parse('2026-10-03 16:01:00 UTC'));
        $id = $this->tournament();
        $this->linkScheduledGame($id, ['timezone' => 'Australia/Sydney']);
        DB::table('mirror_venues')->insert([
            'cloud_id' => 91,
            'payload' => json_encode(['location_data' => ['timezone' => 'Australia/Perth']]),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        app(TournamentService::class)->register($id, 'NPL7013', 'Timezone Player', 1, 2);
        $this->fakeBridge();

        $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7013'));
        $lines = $this->lastReceiptLines();
        $printTime = array_values(array_filter($lines, fn (array $line): bool => $line['printed_at'] ?? false));
        $this->assertSame([['text' => 'Printed time unavailable', 'printed_at' => true, 'center' => true]], $printTime);
        $this->assertStringNotContainsString('AEDT', $this->lastReceiptText());
        // A wall-clock schedule is independent of when the receipt is printed.
        $this->assertSame('24/09/2026 6:30 PM', $this->lastReceiptLines()[1]['text']);
    }

    public function test_an_unlinked_desk_uses_print_date_until_it_has_an_actual_start_time(): void
    {
        $this->travelTo(Carbon::parse('2026-09-24 15:30:00 UTC'));
        $id = $this->tournament();
        DB::table('tournament_sessions')->where('id', $id)->update(['created_at' => '2026-09-01 00:00:00']);
        app(TournamentService::class)->register($id, 'NPL7014', 'Walk In', 2, 8);
        $this->fakeBridge();

        $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7014'));
        $this->assertSame('Date 25/09/2026', $this->lastReceiptLines()[1]['text']);

        DB::table('tournament_sessions')->where('id', $id)->update(['started_at' => '2026-09-24 08:30:00']);
        $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7014'));
        $this->assertSame('Started 24/09/2026 6:30 PM', $this->lastReceiptLines()[1]['text']);
    }

    public function test_rebuy_and_addon_receipts_use_the_chosen_tier_not_the_buy_in_or_total_stack(): void
    {
        $id = $this->tournament([
            'rebuy_tiers' => [
                ['price_cents' => 5000, 'chips' => 20000],
                ['price_cents' => 7500, 'chips' => 35000],
            ],
            'addon_tiers' => [
                ['price_cents' => 1000, 'chips' => 5000],
                ['price_cents' => 2500, 'chips' => 15000],
            ],
        ]);
        app(TournamentService::class)->register($id, 'NPL7015', 'Tier Player', 3, 2);
        app(TournamentClockService::class)->start($id);
        $this->fakeBridge();

        foreach ([['rebuy', 'REBUY', '$75.00', '35,000'], ['addon', 'ADD-ON', '$25.00', '15,000']] as [$action, $label, $price, $chips]) {
            $this->postJson("/api/v1/desk/{$id}/act", [
                'player_npl_id' => 'NPL7015',
                'action' => $action,
                'tier' => 1,
            ])->assertOk()->assertJsonPath('data.result.receipt', 'printed');

            $receipt = $this->lastReceiptText();
            $this->assertStringContainsString("{$label}\n{$price}\nChips: {$chips}", $receipt);
            $this->assertStringContainsString("TABLE 3\nSEAT 2", $receipt);
            $this->assertStringNotContainsString('$100.00', $receipt);
        }
    }

    public function test_keyed_receipts_select_their_recorded_sale_even_when_a_later_sale_exists(): void
    {
        $id = $this->tournament();
        app(TournamentService::class)->register($id, 'NPL7016', 'Concurrent Player', 4, 6);
        $this->fakeBridge();

        foreach (['rebuy', 'addon'] as $action) {
            foreach ([['selected', 7500, 35000], ['later', 12000, 70000]] as [$key, $price, $chips]) {
                DB::table('tournament_actions')->insert([
                    'tournament_session_id' => $id,
                    'player_npl_id' => 'NPL7016',
                    'action' => $action,
                    'idempotency_key' => "{$action}:{$key}",
                    'price_cents' => $price,
                    'chips' => $chips,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }
            $this->assertSame('printed', $this->printRecordedAction($id, 'NPL7016', $action, ['idempotency_key' => "{$action}:selected"]));
            $receipt = $this->lastReceiptText();
            $this->assertStringContainsString("$75.00\nChips: 35,000", $receipt);
            $this->assertStringNotContainsString('$120.00', $receipt);
            $this->assertStringNotContainsString('70,000', $receipt);
        }
    }

    public function test_a_missing_keyed_sale_never_prints_another_players_sale_or_an_invented_zero(): void
    {
        $id = $this->tournament();
        app(TournamentService::class)->register($id, 'NPL7017', 'First Player');
        app(TournamentService::class)->register($id, 'NPL7018', 'Other Player');
        DB::table('tournament_actions')->insert([
            'tournament_session_id' => $id,
            'player_npl_id' => 'NPL7018',
            'action' => 'rebuy',
            'idempotency_key' => 'tsr:other-player',
            'price_cents' => 5000,
            'chips' => 20000,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $this->fakeBridge();

        $this->assertSame('failed', $this->printRecordedAction($id, 'NPL7017', 'rebuy', ['idempotency_key' => 'tsr:other-player']));
        Http::assertNotSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt'));
    }

    public function test_disabled_printing_sells_without_touching_the_bridge(): void
    {
        DB::table('receipt_settings')->insert([
            'enabled' => false,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $id = $this->tournament();
        $this->mirrorPlayer('NPL7003', 'Quiet Buyer');
        $this->fakeBridge();

        $response = $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7003',
            'action' => 'buy_in',
        ])->assertOk();

        $this->assertSame('disabled', $response->json('data.result.receipt'));
        Http::assertNotSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/print/receipt'));
    }

    public function test_a_dead_printer_never_blocks_the_sale(): void
    {
        $id = $this->tournament();
        $this->mirrorPlayer('NPL7004', 'Still Paid');

        Http::fake([
            '*/api/print/receipt' => Http::response(['error' => 'open printer failed'], 502),
            '*' => Http::response(['ok' => true, 'data' => ['tournament' => [], 'broadcast' => false]]),
        ]);

        $response = $this->postJson("/api/v1/desk/{$id}/act", [
            'player_npl_id' => 'NPL7004',
            'action' => 'buy_in',
        ])->assertOk();

        $this->assertSame('failed', $response->json('data.result.receipt'));
        $this->assertDatabaseHas('tournament_actions', ['player_npl_id' => 'NPL7004', 'action' => 'buy_in']);
    }

    public function test_settings_roundtrip_and_test_print(): void
    {
        $this->fakeBridge();

        $this->getJson('/api/v1/receipts/settings')
            ->assertOk()
            ->assertJsonPath('data.settings.enabled', true);

        $this->postJson('/api/v1/receipts/settings', [
            'enabled' => true,
            'printer_name' => 'Front Desk Printer',
            'header_text' => 'NPL POKER',
            'footer_text' => 'Good luck!',
        ])->assertOk()->assertJsonPath('data.settings.printer_name', 'Front Desk Printer');

        $this->postJson('/api/v1/receipts/test')
            ->assertOk()
            ->assertJsonPath('data.result', 'printed');

        $lines = $this->lastReceiptLines();
        $this->assertSame(['text' => 'NPL', 'logo' => true, 'center' => true], $lines[0]);
        $receipt = $this->lastReceiptText();
        $this->assertStringContainsString("Sample Venue\nTEST RECEIPT\nGuaranteed: $2,000", $receipt);
        $this->assertStringContainsString("TABLE 1\nSEAT 1\nTest Player", $receipt);
        $this->assertStringContainsString("BUY-IN\n$0.00\nChips: 20,000", $receipt);
        $this->assertStringContainsString("npl.com.au\nGood luck!", $receipt);
        $this->assertCount(2, array_filter($lines, fn (array $line): bool => $line['divider'] ?? false));
        $this->assertCount(1, array_filter($lines, fn (array $line): bool => $line['printed_at'] ?? false));
    }
}
