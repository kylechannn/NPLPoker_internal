<?php

namespace Tests\Feature;

use App\Services\Tournament\TournamentService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Request as ClientRequest;
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

    private function tournament(): int
    {
        $result = app(TournamentService::class)->create([
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
        ]);

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

    /** Every line of the last receipt POSTed to the bridge, joined. */
    private function lastReceiptText(): string
    {
        $text = '';
        Http::assertSent(function (ClientRequest $request) use (&$text): bool {
            if (! str_contains($request->url(), '/api/print/receipt')) {
                return false;
            }
            $lines = (array) ($request->data()['lines'] ?? []);
            $text = implode("\n", array_map(fn ($line): string => (string) ($line['text'] ?? ''), $lines));

            return true;
        });

        return $text;
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
        $this->assertStringContainsString('Table 1 - Seat 1', $receipt);
        $this->assertStringContainsString('Amount: $100.00', $receipt);
        $this->assertStringContainsString('Venue desk', $receipt);
        $this->assertStringContainsString('See you Friday!', $receipt);

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
        $this->assertStringContainsString('Amount: $5.00', $this->lastReceiptText());
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
    }
}
