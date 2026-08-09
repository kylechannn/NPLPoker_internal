<?php

declare(strict_types=1);

namespace App\Services\Printing;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Composes and prints the money receipts. Every buy-in, rebuy, add-on
 * and jackpot entry — whether the desk scanned it or an admin phone
 * resolved it — flows through here and prints SILENTLY on the venue's
 * receipt printer via the Go host's raw-print bridge. No dialogs. The
 * header and footer are the venue's own customisable words; the body
 * always carries the player, the table and seat, and the money.
 *
 * Printing never breaks the money write: any failure is a logged status
 * ("failed"), and the desk keeps moving.
 */
final class ReceiptService
{
    private const KIND_LABELS = [
        'buy_in' => 'BUY-IN',
        'rebuy' => 'REBUY',
        'addon' => 'ADD-ON',
        'jackpot' => 'JACKPOT ENTRY',
    ];

    /**
     * The venue's receipt machine is the POS-80 class: 80mm paper, 48
     * characters per line in the standard font. Dividers span the full
     * slip.
     */
    private const RECEIPT_COLUMNS = 48;

    /** @return array{enabled: bool, printer_name: ?string, header_text: ?string, footer_text: ?string} */
    public function settings(): array
    {
        $row = DB::table('receipt_settings')->first();

        return [
            'enabled' => $row !== null ? (bool) $row->enabled : true,
            'printer_name' => $row->printer_name ?? null,
            'header_text' => $row->header_text ?? null,
            'footer_text' => $row->footer_text ?? "Thank you & good luck!",
        ];
    }

    /** @return array{enabled: bool, printer_name: ?string, header_text: ?string, footer_text: ?string} */
    public function update(array $data): array
    {
        $values = [
            'enabled' => (bool) ($data['enabled'] ?? true),
            'printer_name' => isset($data['printer_name']) && trim((string) $data['printer_name']) !== ''
                ? trim((string) $data['printer_name'])
                : null,
            'header_text' => isset($data['header_text']) && trim((string) $data['header_text']) !== ''
                ? trim((string) $data['header_text'])
                : null,
            'footer_text' => isset($data['footer_text']) && trim((string) $data['footer_text']) !== ''
                ? trim((string) $data['footer_text'])
                : null,
            'updated_at' => now(),
        ];

        $existing = DB::table('receipt_settings')->first();
        if ($existing === null) {
            DB::table('receipt_settings')->insert($values + ['created_at' => now()]);
        } else {
            DB::table('receipt_settings')->where('id', $existing->id)->update($values);
        }

        return $this->settings();
    }

    /**
     * Print the receipt for a just-applied desk action. Returns a status
     * the caller can surface: printed | failed | disabled.
     */
    public function printAction(int $sessionId, object $session, string $nplId, string $action, array $options = []): string
    {
        $settings = $this->settings();
        if (! $settings['enabled']) {
            return 'disabled';
        }

        if (! isset(self::KIND_LABELS[$action])) {
            return 'disabled';
        }

        try {
            $lines = $this->composeLines($sessionId, $session, $nplId, $action, $options, $settings);

            return $this->send($settings['printer_name'], $lines) ? 'printed' : 'failed';
        } catch (Throwable $e) {
            Log::info('receipt print failed', ['session' => $sessionId, 'npl_id' => $nplId, 'action' => $action, 'error' => $e->getMessage()]);

            return 'failed';
        }
    }

    /** A sample receipt for the settings card's Test print button. */
    public function printTest(): string
    {
        $settings = $this->settings();
        $lines = array_merge(
            $this->customLines($settings['header_text']),
            [
                ['text' => 'NPL POKER', 'center' => true, 'bold' => true],
                ['text' => 'Receipt printer test', 'center' => true],
                ['text' => str_repeat('-', self::RECEIPT_COLUMNS)],
                ['text' => 'BUY-IN', 'center' => true, 'bold' => true, 'big' => true],
                ['text' => 'Player: Test Player (NPL0000)'],
                ['text' => 'Table 3 - Seat 5', 'bold' => true],
                ['text' => 'Amount: $100.00'],
                ['text' => 'Chips: 20,000'],
                ['text' => now()->format('D j M Y g:ia').' - Venue desk'],
                ['text' => str_repeat('-', self::RECEIPT_COLUMNS)],
            ],
            $this->customLines($settings['footer_text'], center: true),
        );

        return $this->send($settings['printer_name'], $lines) ? 'printed' : 'failed';
    }

    /** @return list<array<string, mixed>> */
    private function composeLines(int $sessionId, object $session, string $nplId, string $action, array $options, array $settings): array
    {
        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        $latestAction = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->where('action', $action)
            ->orderByDesc('id')
            ->first();

        $priceCents = (int) ($latestAction->price_cents ?? 0);
        $chips = (int) ($latestAction->chips ?? 0);
        $displayName = trim((string) ($entry->player_name ?? '')) ?: $nplId;

        // Phone-resolved rows arrive with the table-service idempotency
        // key — that is what tells the receipt who handled the sale.
        $viaPhone = str_starts_with((string) ($options['idempotency_key'] ?? ''), 'tsr:');

        $lines = $this->customLines($settings['header_text']);

        if (trim((string) ($session->name ?? '')) !== '') {
            $lines[] = ['text' => (string) $session->name, 'center' => true, 'bold' => true];
        }
        if (trim((string) ($session->venue_name ?? '')) !== '') {
            $lines[] = ['text' => (string) $session->venue_name, 'center' => true];
        }

        $lines[] = ['text' => str_repeat('-', self::RECEIPT_COLUMNS)];
        $lines[] = ['text' => self::KIND_LABELS[$action], 'center' => true, 'bold' => true, 'big' => true];
        $lines[] = ['text' => sprintf('Player: %s (%s)', $displayName, $nplId)];

        if ($entry !== null && $entry->table_number !== null && $entry->seat_number !== null) {
            $lines[] = ['text' => sprintf('Table %d - Seat %d', (int) $entry->table_number, (int) $entry->seat_number), 'bold' => true];
        }

        // Voucher-covered entries: the stored price is only the deficit, so
        // the tickets that paid the rest must appear on the paper too.
        $meta = json_decode((string) ($latestAction->meta ?? ''), true);
        $meta = is_array($meta) ? $meta : [];
        $ticketCodes = array_values(array_filter(array_map('strval', (array) ($meta['voucher_codes'] ?? []))));
        $coveredCents = (int) ($meta['voucher_covered_cents'] ?? 0);

        if ($ticketCodes !== []) {
            $lines[] = ['text' => sprintf(
                'Tickets: %s ($%s covered)',
                implode(', ', $ticketCodes),
                number_format($coveredCents / 100, 2),
            )];
        } elseif ($coveredCents > 0 && isset($meta['voucher_code'])) {
            $lines[] = ['text' => sprintf('Voucher: %s ($%s covered)', (string) $meta['voucher_code'], number_format($coveredCents / 100, 2))];
        }

        if ($priceCents > 0) {
            $lines[] = ['text' => 'Amount: $'.number_format($priceCents / 100, 2)];
        }
        if ($chips > 0) {
            $lines[] = ['text' => 'Chips: '.number_format($chips)];
        }

        $lines[] = ['text' => now()->format('D j M Y g:ia').' - '.($viaPhone ? 'Admin phone' : 'Venue desk')];
        $lines[] = ['text' => str_repeat('-', self::RECEIPT_COLUMNS)];

        return array_merge($lines, $this->customLines($settings['footer_text'], center: true));
    }

    /**
     * The venue's own words, one printed line per text line.
     *
     * @return list<array<string, mixed>>
     */
    private function customLines(?string $text, bool $center = true): array
    {
        if ($text === null || trim($text) === '') {
            return [];
        }

        $lines = [];
        foreach (preg_split('/\r\n|\r|\n/', trim($text)) ?: [] as $line) {
            $lines[] = ['text' => $line, 'center' => $center];
        }

        return $lines;
    }

    /** @param list<array<string, mixed>> $lines */
    private function send(?string $printerName, array $lines): bool
    {
        $bridge = (string) config('nplcloud.host_bridge');
        if ($bridge === '') {
            Log::info('receipt print skipped: no host bridge configured');

            return false;
        }

        $response = Http::timeout(6)->connectTimeout(3)->post($bridge.'/api/print/receipt', [
            'printer' => $printerName ?? '',
            'lines' => $lines,
        ]);

        if (! $response->successful()) {
            Log::info('receipt bridge refused the print', ['status' => $response->status(), 'body' => $response->body()]);

            return false;
        }

        return true;
    }
}
