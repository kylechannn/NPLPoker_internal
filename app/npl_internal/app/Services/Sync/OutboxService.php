<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * Local changes queued for the cloud (seat moves, buy-ins, add-ons once the
 * operational layer lands).
 *
 * Differences from EdgeHost's outbox, which retried forever with no ceiling
 * and no dead-letter state: entries here carry an idempotency key that is
 * also sent as the HTTP header (so a retry can never double-apply), attempts
 * are capped, and an exhausted entry moves to `dead` where it is visible
 * instead of silently cycling every hour.
 */
final class OutboxService
{
    public function __construct(private readonly CloudClient $cloud) {}

    /** Queue a change. Re-queuing identical content is a no-op. */
    public function enqueue(string $entityType, string $operation, array $payload): string
    {
        $key = substr(hash('sha256', $entityType.'|'.$operation.'|'.$this->canonical($payload)), 0, 40);

        DB::table('sync_outbox')->updateOrInsert(
            ['idempotency_key' => $key],
            [
                'entity_type' => $entityType,
                'operation' => $operation,
                'payload' => json_encode($payload),
                'status' => 'pending',
                'available_at' => now(),
                'updated_at' => now(),
                'created_at' => now(),
            ],
        );

        return $key;
    }

    /** @return array{sent: int, failed: int, dead: int, remaining: int} */
    public function drain(?int $limit = null): array
    {
        $limit ??= (int) config('nplcloud.outbox.chunk', 20);
        $maxAttempts = (int) config('nplcloud.outbox.max_attempts', 12);

        $entries = DB::table('sync_outbox')
            ->where('status', 'pending')
            ->where(fn ($query) => $query->whereNull('available_at')->orWhere('available_at', '<=', now()))
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $sent = 0;
        $failed = 0;
        $dead = 0;

        foreach ($entries as $entry) {
            $attempts = (int) $entry->attempts + 1;

            try {
                $this->cloud->postJson(
                    '/api/v1/internal/outbox',
                    [
                        'entity_type' => $entry->entity_type,
                        'operation' => $entry->operation,
                        'payload' => json_decode((string) $entry->payload, true),
                    ],
                    $entry->idempotency_key,
                );

                DB::table('sync_outbox')->where('id', $entry->id)->update([
                    'status' => 'sent',
                    'attempts' => $attempts,
                    'sent_at' => now(),
                    'last_error' => null,
                    'updated_at' => now(),
                ]);
                $sent++;
            } catch (Throwable $e) {
                $retryable = ! ($e instanceof CloudException) || $e->isRetryable();
                $exhausted = $attempts >= $maxAttempts;

                // Exponential backoff, capped at an hour.
                $delay = min(3600, 5 * (2 ** min($attempts, 7)));

                DB::table('sync_outbox')->where('id', $entry->id)->update([
                    'status' => ($retryable && ! $exhausted) ? 'pending' : 'dead',
                    'attempts' => $attempts,
                    'available_at' => now()->addSeconds($delay),
                    'last_error' => Str::limit($e->getMessage(), 500),
                    'updated_at' => now(),
                ]);

                ($retryable && ! $exhausted) ? $failed++ : $dead++;

                // One unreachable means offline for all of them. Stop the
                // batch instead of paying a connect timeout per entry — an
                // inline drain runs on the desk's only PHP worker, and a
                // stack of timeouts would freeze the operator's screen.
                if ($e instanceof CloudException && $e->errorCode === CloudException::UNREACHABLE) {
                    break;
                }
            }
        }

        return [
            'sent' => $sent,
            'failed' => $failed,
            'dead' => $dead,
            'remaining' => DB::table('sync_outbox')->where('status', 'pending')->count(),
        ];
    }

    private function canonical(array $payload): string
    {
        ksort($payload);

        return (string) json_encode($payload);
    }
}
