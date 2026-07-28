<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Carbon\CarbonImmutable;
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

    /**
     * Strict FIFO: entries leave in the order the desk created them, and a
     * parked entry blocks everything younger. A seat move must never reach
     * the cloud before the buy-in it depends on — head-of-line blocking is
     * the price of causality, and a poisoned head goes visibly `dead` after
     * max_attempts rather than silently letting the queue reorder.
     *
     * @return array{sent: int, failed: int, dead: int, remaining: int}
     */
    public function drain(?int $limit = null): array
    {
        $limit ??= (int) config('nplcloud.outbox.chunk', 20);
        $maxAttempts = (int) config('nplcloud.outbox.max_attempts', 12);

        $entries = DB::table('sync_outbox')
            ->where(fn ($query) => $query
                ->where('status', 'pending')
                // A crashed drain leaves `sending` behind; reclaim after 5m.
                ->orWhere(fn ($stale) => $stale->where('status', 'sending')->where('updated_at', '<', now()->subMinutes(5))))
            ->orderBy('id')
            ->limit($limit)
            ->get();

        $sent = 0;
        $failed = 0;
        $dead = 0;

        foreach ($entries as $entry) {
            // FIFO: a backed-off head parks the whole queue until it is due.
            if ($entry->available_at !== null && CarbonImmutable::parse($entry->available_at)->isFuture()) {
                break;
            }

            // Atomic claim so the scheduled sweep and an inline drain never
            // send the same entry concurrently.
            $claimed = DB::table('sync_outbox')
                ->where('id', $entry->id)
                ->where(fn ($query) => $query
                    ->where('status', 'pending')
                    ->orWhere(fn ($stale) => $stale->where('status', 'sending')->where('updated_at', '<', now()->subMinutes(5))))
                ->update(['status' => 'sending', 'updated_at' => now()]);

            if ($claimed === 0) {
                // Another drain holds the head; younger entries must wait.
                break;
            }

            $attempts = (int) $entry->attempts + 1;

            try {
                $response = $this->cloud->postJson(
                    '/api/v1/internal/outbox',
                    [
                        'entity_type' => $entry->entity_type,
                        'operation' => $entry->operation,
                        'payload' => json_decode((string) $entry->payload, true),
                    ],
                    $entry->idempotency_key,
                );

                $verdict = $this->verdictFor($response);

                if ($verdict === 'retry') {
                    // Delivered, but the cloud could not apply it yet (player
                    // not synced, ordering). 2xx is NOT success here — marking
                    // it sent would silently lose a paid buy-in.
                    $exhausted = $attempts >= $maxAttempts;
                    $delay = min(3600, 5 * (2 ** min($attempts, 7)));

                    DB::table('sync_outbox')->where('id', $entry->id)->update([
                        'status' => $exhausted ? 'dead' : 'pending',
                        'attempts' => $attempts,
                        'available_at' => now()->addSeconds($delay),
                        'last_error' => Str::limit('Cloud did not apply: '.json_encode($response['data']['result']['detail'] ?? []), 500),
                        'updated_at' => now(),
                    ]);

                    $exhausted ? $dead++ : $failed++;
                    break;
                }

                if ($verdict === 'rejected') {
                    // Permanently unapplicable (unknown entity/session).
                    // Dead is visible; sent would be a silent lie.
                    DB::table('sync_outbox')->where('id', $entry->id)->update([
                        'status' => 'dead',
                        'attempts' => $attempts,
                        'last_error' => Str::limit('Cloud rejected: '.json_encode($response['data']['result']['detail'] ?? []), 500),
                        'updated_at' => now(),
                    ]);
                    $dead++;

                    continue;
                }

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

                // Any failure stops the batch: ordering must hold, and an
                // offline desk pays one connect timeout, not one per entry —
                // an inline drain runs on the desk's only PHP worker.
                break;
            }
        }

        return [
            'sent' => $sent,
            'failed' => $failed,
            'dead' => $dead,
            'remaining' => DB::table('sync_outbox')->where('status', 'pending')->count(),
        ];
    }

    /**
     * How the cloud's 2xx answer should be treated. Older clouds without
     * the result envelope default to 'sent' — they applied blindly.
     */
    private function verdictFor(array $response): string
    {
        $result = $response['data']['result'] ?? null;

        if (! is_array($result)) {
            return 'sent';
        }

        if (($response['data']['duplicate'] ?? false) === true
            || ($result['applied'] ?? true) === true
            || ($result['detail']['duplicate'] ?? false) === true) {
            return 'sent';
        }

        return ($result['detail']['retryable'] ?? false) === true ? 'retry' : 'rejected';
    }

    private function canonical(array $payload): string
    {
        ksort($payload);

        return (string) json_encode($payload);
    }
}
