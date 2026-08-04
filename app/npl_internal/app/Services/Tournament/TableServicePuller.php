<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Players\PlayerResolver;
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

    /** @return array{applied: list<array>, failed: list<array>} */
    public function sync(int $sessionId): array
    {
        if (! $this->license->isActivated()) {
            return ['applied' => [], 'failed' => []];
        }

        try {
            $response = $this->cloud->getJson('/api/v1/internal/table-service/pending', [
                'uid' => $this->broadcaster->uid($sessionId),
            ]);
            $rows = $response['data']['data'] ?? [];
        } catch (Throwable $e) {
            // Flaky internet must never break the desk — next poll retries.
            Log::info('table service pull skipped', ['session' => $sessionId, 'error' => $e->getMessage()]);

            return ['applied' => [], 'failed' => []];
        }

        $applied = [];
        $failed = [];

        foreach ($rows as $row) {
            $id = (int) ($row['id'] ?? 0);
            $nplId = trim((string) ($row['npl_id'] ?? ''));
            $kind = (string) ($row['kind'] ?? '');

            if ($id === 0 || $nplId === '' || ! in_array($kind, ['buy_in', 'rebuy'], true)) {
                continue;
            }

            // Resolve like a desk scan would, so the roster shows a name —
            // a miss here means the cloud is unreachable, so retry later.
            if ($this->players->resolve($nplId) === null) {
                continue;
            }

            try {
                $this->desk->apply($sessionId, $nplId, $kind === 'buy_in' ? 'buy_in' : 'rebuy', [
                    'idempotency_key' => 'tsr:'.$id,
                    'first_buy_in' => $kind === 'buy_in',
                ]);

                $entry = ['id' => $id, 'npl_id' => $nplId, 'kind' => $kind, 'table_number' => $row['table_number'] ?? null];
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

        return ['applied' => $applied, 'failed' => $failed];
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
