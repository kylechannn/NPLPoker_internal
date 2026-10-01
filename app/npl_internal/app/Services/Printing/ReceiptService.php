<?php

declare(strict_types=1);

namespace App\Services\Printing;

use Carbon\CarbonImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use RuntimeException;
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
            'footer_text' => $row->footer_text ?? null,
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
            Log::warning('receipt print failed', ['session' => $sessionId, 'npl_id' => $nplId, 'action' => $action, 'error' => $e->getMessage()]);

            return 'failed';
        }
    }

    /** A sample receipt for the settings card's Test print button. */
    public function printTest(): string
    {
        $settings = $this->settings();
        $sampleDate = CarbonImmutable::now('Australia/Sydney');
        $lines = $this->layout([
            'date' => $sampleDate->format('d/m/Y g:i A'),
            'venue' => 'Sample Venue',
            'name' => 'TEST RECEIPT',
            'guarantee' => '$2,000',
            'table' => 1,
            'seat' => 1,
            'player' => 'Test Player',
            'kind' => 'BUY-IN',
            'price_cents' => 0,
            'chips' => 20000,
            'payment_lines' => [],
        ], $settings);

        return $this->send($settings['printer_name'], $lines) ? 'printed' : 'failed';
    }

    /** @return list<array<string, mixed>> */
    private function composeLines(int $sessionId, object $session, string $nplId, string $action, array $options, array $settings): array
    {
        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        $actionQuery = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->where('action', $action);

        // Buy-ins have one entry per player and legacy rows do not store the
        // key. Rebuys/add-ons can overlap: print THIS keyed sale, not whichever
        // one happened to finish last while the cloud broadcast was running.
        if ($action !== 'buy_in' && ! empty($options['idempotency_key'])) {
            $actionQuery->where('idempotency_key', $options['idempotency_key']);
        }
        $latestAction = $actionQuery->orderByDesc('id')->first();
        if ($latestAction === null) {
            throw new RuntimeException('The recorded sale could not be found for this receipt.');
        }

        $priceCents = (int) ($latestAction->price_cents ?? 0);
        $chips = (int) ($latestAction->chips ?? 0);
        $displayName = trim((string) ($entry->player_name ?? '')) ?: $nplId;

        // Voucher-covered entries: the stored price is only the deficit, so
        // the tickets that paid the rest must appear on the paper too.
        $meta = json_decode((string) ($latestAction->meta ?? ''), true);
        $meta = is_array($meta) ? $meta : [];
        $ticketCodes = array_values(array_filter(array_map('strval', (array) ($meta['voucher_codes'] ?? []))));
        $coveredCents = (int) ($meta['voucher_covered_cents'] ?? 0);

        $paymentLines = [];
        if ($ticketCodes !== []) {
            $ticketValues = [];
            $ticketTypes = [];
            foreach ((array) ($meta['voucher_tickets'] ?? []) as $ticket) {
                $ticketValues[(string) ($ticket['code'] ?? '')] = (int) ($ticket['value_cents'] ?? 0);
                $ticketTypes[(string) ($ticket['code'] ?? '')] = (string) ($ticket['type'] ?? 'special_ticket');
            }
            $paymentLines[] = ['text' => sprintf('Entry fee: $%s', number_format(($priceCents + $coveredCents) / 100, 2))];
            foreach ($ticketCodes as $code) {
                $isTicket = ($ticketTypes[$code] ?? 'special_ticket') === 'special_ticket';
                $paymentLines[] = ['text' => ($isTicket ? 'Ticket: ' : 'Voucher: ').$code.($isTicket && array_key_exists($code, $ticketValues)
                    ? ' $'.number_format($ticketValues[$code] / 100, 2) : '')];
            }
            $hasTickets = $ticketTypes === [] || in_array('special_ticket', $ticketTypes, true);
            $paymentLines[] = ['text' => sprintf(($hasTickets ? 'Tickets' : 'Vouchers').' cover: $%s', number_format($coveredCents / 100, 2))];
            $paymentLines[] = ['text' => sprintf('Paid at desk: $%s', number_format($priceCents / 100, 2))];
        } elseif ($coveredCents > 0 && isset($meta['voucher_code'])) {
            $paymentLines[] = ['text' => sprintf('Voucher: %s ($%s covered)', (string) $meta['voucher_code'], number_format($coveredCents / 100, 2))];
        }

        $mirror = ($session->game_session_id ?? null) !== null
            ? DB::table('mirror_game_sessions')->where('session_id', $session->game_session_id)->first()
            : null;
        $payload = $this->decodePayload($mirror->payload ?? null);
        $venueId = $session->venue_id ?? $mirror->venue_id ?? null;
        $venue = $venueId !== null ? DB::table('mirror_venues')->where('cloud_id', $venueId)->first() : null;
        $venuePayload = $this->decodePayload($venue->payload ?? null);
        $timezone = $this->receiptTimezone($payload, $venuePayload);
        $sessionNow = CarbonImmutable::now($timezone);

        $scheduledDate = trim((string) ($mirror->session_date ?? ''));
        $scheduledTime = trim((string) ($mirror->start_time ?? ''));
        if ($scheduledDate !== '') {
            // Cloud date/time columns are venue wall time, not UTC instants.
            $date = CarbonImmutable::parse($scheduledDate, $timezone)->format('d/m/Y');
            if ($scheduledTime !== '') {
                $date .= ' '.CarbonImmutable::parse($scheduledDate.' '.$scheduledTime, $timezone)->format('g:i A');
            }
        } elseif (($session->started_at ?? null) !== null) {
            $date = 'Started '.CarbonImmutable::parse($session->started_at, config('app.timezone'))
                ->setTimezone($timezone)->format('d/m/Y g:i A');
        } else {
            $date = 'Date '.$sessionNow->format('d/m/Y');
        }

        return $this->layout([
            'date' => $date,
            'venue' => trim((string) ($session->venue_name ?? '')) ?: (trim((string) ($mirror->venue_name ?? '')) ?: 'Venue not specified'),
            'name' => trim((string) ($session->name ?? '')) ?: (string) ($mirror->title ?? ''),
            // The backend already formats this and applies per-session
            // overrides. Do not derive a guarantee from buy-ins or payouts.
            'guarantee' => trim((string) ($payload['guarantee'] ?? '')) ?: 'Not specified',
            'table' => $entry->table_number ?? null,
            'seat' => $entry->seat_number ?? null,
            'player' => $displayName,
            'kind' => self::KIND_LABELS[$action],
            'price_cents' => $priceCents,
            'chips' => $chips,
            'payment_lines' => $paymentLines,
        ], $settings);
    }

    /** Both real sales and the test button use the same paper layout. */
    private function layout(array $receipt, array $settings): array
    {
        $center = ['center' => true];
        $strong = $center + ['bold' => true];
        $large = $strong + ['big' => true];
        $divider = ['text' => str_repeat('-', self::RECEIPT_COLUMNS), 'divider' => true];
        $lines = [
            ['text' => 'NPL', 'logo' => true] + $center,
            ['text' => $receipt['date']] + $center,
            ['text' => $receipt['venue']] + $center,
            ['text' => $receipt['name']] + $strong,
            ['text' => 'Guaranteed: '.$receipt['guarantee']] + $strong,
            ...$this->customLines($settings['header_text']),
            $divider,
            ['text' => 'TABLE '.($receipt['table'] ?? 'UNASSIGNED')] + $large,
            ['text' => 'SEAT '.($receipt['seat'] ?? 'UNASSIGNED')] + $large,
            ['text' => $receipt['player']] + $large,
            $divider,
            ['text' => $receipt['kind']] + $center,
            ['text' => '$'.number_format($receipt['price_cents'] / 100, 2)] + $large,
            ['text' => 'Chips: '.number_format($receipt['chips'])] + $strong,
            ...$receipt['payment_lines'],
            ['text' => ''],
            // Only the desktop host knows the laptop's current system clock
            // and timezone. It replaces this marker immediately before print.
            ['text' => 'Printed time unavailable', 'printed_at' => true] + $center,
            ['text' => 'npl.com.au'] + $center,
            ...$this->customLines($settings['footer_text']),
        ];

        return $lines;
    }

    private function decodePayload(?string $raw): array
    {
        $payload = json_decode($raw ?? '', true);

        return is_array($payload) ? $payload : [];
    }

    private function receiptTimezone(array $sessionPayload, array $venuePayload): string
    {
        foreach ([$sessionPayload['timezone'] ?? null, $venuePayload['location_data']['timezone'] ?? null] as $candidate) {
            if (! is_string($candidate) || trim($candidate) === '') {
                continue;
            }
            try {
                return (new DateTimeZone($candidate))->getName();
            } catch (Throwable) {
                // An incomplete or invalid mirror must not stop the sale.
            }
        }

        // Same fallback used by the cloud session generator and presenter.
        return 'Australia/Sydney';
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
            Log::warning('receipt bridge refused the print', ['status' => $response->status(), 'body' => $response->body()]);

            return false;
        }

        return true;
    }
}
