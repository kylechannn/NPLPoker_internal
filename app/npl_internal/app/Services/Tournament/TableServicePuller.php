<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Players\PlayerResolver;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * The desk's leg of table service. Players press Buy-In / Rebuy on their
 * phones; the admin resolves at the table; this pulls those resolutions
 * from the cloud and applies them to the LOCAL ledger — the desk stays
 * the book of record, and the clock broadcast then carries the new
 * counts to every screen.
 *
 * Replay-proof twice over: the ledger write uses `tsr:{id}` as its
 * idempotency key, and the cloud ack removes the row from the feed. A
 * lost ack just means a harmless re-apply that the ledger swallows.
 */
final class TableServicePuller
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly TournamentDeskService $desk,
        private readonly TournamentBroadcaster $broadcaster,
        private readonly LicenseKeyProvider $license,
        private readonly PlayerResolver $players,
    ) {}

    /**
     * One pull, the whole picture: the pending queue for the desk's own
     * panel (the OS is the main control), the admin-resolved money kinds
     * to write into the ledger, and the recent history.
     *
     * @return array{applied: list<array>, failed: list<array>, pending: list<array>, recent: list<array>}
     */
    public function sync(int $sessionId): array
    {
        $empty = ['applied' => [], 'failed' => [], 'pending' => [], 'recent' => []];

        if (! $this->license->isActivated()) {
            return $empty;
        }

        try {
            $response = $this->cloud->getJson('/api/v1/internal/table-service/requests', [
                'uid' => $this->broadcaster->uid($sessionId),
            ]);
            $data = $response['data'] ?? [];
            $rows = $data['apply'] ?? [];
        } catch (Throwable $e) {
            // Flaky internet must never break the desk — next poll retries.
            Log::info('table service pull skipped', ['session' => $sessionId, 'error' => $e->getMessage()]);

            return $empty;
        }

        $applied = [];
        $failed = [];

        foreach ($rows as $row) {
            $id = (int) ($row['id'] ?? 0);
            $nplId = trim((string) ($row['npl_id'] ?? ''));
            $kind = (string) ($row['kind'] ?? '');

            if ($id === 0 || $nplId === '' || ! in_array($kind, ['buy_in', 'rebuy', 'addon'], true)) {
                continue;
            }

            // Resolve like a desk scan would, so the roster shows a name —
            // a miss here means the cloud is unreachable, so retry later.
            if ($this->players->resolve($nplId) === null) {
                continue;
            }

            try {
                $applyResult = $this->desk->apply($sessionId, $nplId, $kind, [
                    'idempotency_key' => 'tsr:'.$id,
                    'first_buy_in' => $kind === 'buy_in',
                ]);

                $entry = [
                    'id' => $id,
                    'npl_id' => $nplId,
                    'kind' => $kind,
                    'table_number' => $row['table_number'] ?? null,
                    // What the OS tells the operator: the phone sale's
                    // receipt printed (or why it did not).
                    'receipt' => is_array($applyResult) ? ($applyResult['receipt'] ?? null) : null,
                ];
                $applied[] = $entry;
                $this->ack($id, true, null);
            } catch (ValidationException $e) {
                // Permanent: caps used up, registration closed, unknown
                // player — the admin sees the reason on the request.
                $reason = collect($e->errors())->flatten()->first() ?? 'The desk refused this action.';
                $failed[] = ['id' => $id, 'npl_id' => $nplId, 'kind' => $kind, 'error' => (string) $reason];
                $this->ack($id, false, (string) $reason);
            } catch (Throwable $e) {
                // Transient — leave unacked so the next poll retries.
                Log::info('table service apply deferred', ['request' => $id, 'error' => $e->getMessage()]);
            }
        }

        return [
            'applied' => $applied,
            'failed' => $failed,
            'pending' => array_values((array) ($data['pending'] ?? [])),
            'recent' => array_values((array) ($data['recent'] ?? [])),
        ];
    }

    /**
     * The desk handles a request itself — the OS is the main control.
     * Money kinds are written into the LOCAL ledger first (idempotent by
     * tsr:{id}), then the cloud is told "resolved by the desk, already
     * applied" with the desk's own configured price on the record.
     *
     * @return array{id:int, kind:string, npl_id:string}
     */
    public function handle(int $sessionId, int $requestId): array
    {
        $response = $this->cloud->getJson('/api/v1/internal/table-service/requests', [
            'uid' => $this->broadcaster->uid($sessionId),
        ]);

        $row = collect($response['data']['pending'] ?? [])->first(
            fn ($candidate): bool => (int) ($candidate['id'] ?? 0) === $requestId,
        );

        if ($row === null) {
            throw ValidationException::withMessages([
                'request' => ['That request was already handled (or withdrawn).'],
            ]);
        }

        $nplId = trim((string) ($row['npl_id'] ?? ''));
        $kind = (string) ($row['kind'] ?? '');
        $money = in_array($kind, ['buy_in', 'rebuy', 'addon'], true);

        $amountCents = null;

        if ($money) {
            if ($nplId === '' || $this->players->resolve($nplId) === null) {
                throw ValidationException::withMessages([
                    'request' => ['That player could not be resolved — check the connection and retry.'],
                ]);
            }

            // Same funnel as a scan: gates and caps speak here, and their
            // sentence goes straight back to the operator.
            $this->desk->apply($sessionId, $nplId, $kind, [
                'idempotency_key' => 'tsr:'.$requestId,
                'first_buy_in' => $kind === 'buy_in',
            ]);

            $amountCents = $this->configuredPrice($sessionId, $kind);
        }

        $this->cloud->postJson(
            '/api/v1/internal/table-service/requests/'.$requestId.'/resolve',
            ['applied' => $money, 'amount_cents' => $amountCents],
            'tsr-desk:'.$requestId,
        );

        return ['id' => $requestId, 'kind' => $kind, 'npl_id' => $nplId];
    }

    /** The desk's own configured price for a kind — what goes on the record. */
    private function configuredPrice(int $sessionId, string $kind): ?int
    {
        $session = DB::table('tournament_sessions')->where('id', $sessionId)->first();

        if ($session === null) {
            return null;
        }

        return match ($kind) {
            'buy_in' => (int) ($session->buy_in_price_cents ?? 0),
            'rebuy' => (int) (TournamentService::rebuyTiers($session)[0]['price_cents'] ?? 0),
            'addon' => (int) (TournamentService::addonTiers($session)[0]['price_cents'] ?? 0),
            default => null,
        };
    }

    private function ack(int $requestId, bool $ok, ?string $error): void
    {
        try {
            $this->cloud->postJson(
                '/api/v1/internal/table-service/requests/'.$requestId.'/applied',
                ['ok' => $ok, 'error' => $error],
                'tsr-ack:'.$requestId,
            );
        } catch (Throwable $e) {
            // The ledger write is idempotent — a re-apply after a lost ack
            // is a no-op, so losing this is safe.
            Log::info('table service ack deferred', ['request' => $requestId, 'error' => $e->getMessage()]);
        }
    }
}
