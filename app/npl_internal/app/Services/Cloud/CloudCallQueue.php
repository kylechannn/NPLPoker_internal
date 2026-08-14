<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use App\Services\Sync\SyncService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * The generic cloud call queue — the outbox's sibling for desk actions
 * that replay EXISTING cloud endpoints (no new cloud contract needed).
 *
 * Submit → queue → backend: the controller applies its optimistic local
 * change, enqueues the cloud call, and answers the UI immediately. An
 * inline drain fires right after enqueue so a healthy network lands the
 * change in under a second; the 15s scheduled sweep carries retries and
 * anything queued while the link was down.
 *
 * Ordering is FIFO PER GROUP (one session's operations keep their order);
 * a backed-off group never blocks the others. Retryable failures back off
 * exponentially; permanent refusals go visibly `dead` for the operator's
 * queue panel rather than silently vanishing.
 */
final class CloudCallQueue
{
    private const MAX_ATTEMPTS = 12;

    public function __construct(
        private readonly CloudClient $cloud,
        private readonly SyncService $sync,
    ) {}

    /**
     * @param array{group?: ?string, label?: string, idempotency_key?: ?string, tolerate_missing?: bool} $options
     */
    public function enqueue(string $method, string $path, ?array $payload = null, array $options = []): int
    {
        $id = (int) DB::table('cloud_call_queue')->insertGetId([
            'group_key' => $options['group'] ?? null,
            'label' => Str::limit($options['label'] ?? strtoupper($method).' '.$path, 160, ''),
            'method' => strtolower($method),
            'path' => $path,
            'payload' => $payload !== null ? json_encode($payload) : null,
            'idempotency_key' => $options['idempotency_key'] ?? null,
            'tolerate_missing' => (bool) ($options['tolerate_missing'] ?? false),
            'status' => 'pending',
            'available_at' => now(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        // Land it NOW when the network allows — the queue is for resilience
        // and instant UI, not for making every change wait for the sweep.
        rescue(fn (): array => $this->drain(8), report: false);

        return $id;
    }

    /**
     * @return array{sent: int, deferred: int, dead: int, pending: int}
     */
    public function drain(?int $limit = null): array
    {
        $limit ??= 24;

        $heads = DB::table('cloud_call_queue')
            ->where(fn ($query) => $query
                ->where('status', 'pending')
                // A crashed drain leaves `sending` behind; reclaim after 5m.
                ->orWhere(fn ($stale) => $stale->where('status', 'sending')->where('updated_at', '<', now()->subMinutes(5))))
            ->orderBy('id')
            ->limit(200)
            ->get();

        $sent = 0;
        $deferred = 0;
        $dead = 0;
        $parkedGroups = [];
        $touchedSessions = [];

        foreach ($heads as $entry) {
            if ($sent + $dead >= $limit) {
                break;
            }

            $group = $entry->group_key ?? 'job:'.$entry->id;

            // FIFO within the group: once its head parks, the rest wait.
            if (isset($parkedGroups[$group])) {
                continue;
            }

            if ($entry->available_at !== null && CarbonImmutable::parse($entry->available_at)->isFuture()) {
                $parkedGroups[$group] = true;
                $deferred++;

                continue;
            }

            // Atomic claim: the inline drain and the scheduled sweep must
            // never send the same job twice concurrently.
            $claimed = DB::table('cloud_call_queue')
                ->where('id', $entry->id)
                ->where(fn ($query) => $query
                    ->where('status', 'pending')
                    ->orWhere(fn ($stale) => $stale->where('status', 'sending')->where('updated_at', '<', now()->subMinutes(5))))
                ->update(['status' => 'sending', 'updated_at' => now()]);

            if ($claimed === 0) {
                $parkedGroups[$group] = true;

                continue;
            }

            $attempts = (int) $entry->attempts + 1;
            $payload = $entry->payload !== null ? (array) json_decode((string) $entry->payload, true) : [];

            try {
                match ($entry->method) {
                    'post' => $this->cloud->postJson($entry->path, $payload, $entry->idempotency_key ?: null),
                    'delete' => $this->cloud->deleteJson($entry->path),
                    default => throw new \InvalidArgumentException("Unsupported queue method [{$entry->method}]."),
                };

                $this->markSent($entry->id, $attempts);
                $sent++;
                $this->rememberSession($touchedSessions, $entry->group_key);
            } catch (CloudException $e) {
                // "Already done" answers count as done for removal-type jobs
                // — a retry after a half-applied attempt must not go dead.
                if ($entry->tolerate_missing && in_array($e->status, [404, 410], true)) {
                    $this->markSent($entry->id, $attempts, 'Already applied on the cloud.');
                    $sent++;
                    $this->rememberSession($touchedSessions, $entry->group_key);

                    continue;
                }

                $retryable = $e->isRetryable();
                $exhausted = $attempts >= self::MAX_ATTEMPTS;
                $delay = min(3600, 5 * (2 ** min($attempts, 7)));

                DB::table('cloud_call_queue')->where('id', $entry->id)->update([
                    'status' => ($retryable && ! $exhausted) ? 'pending' : 'dead',
                    'attempts' => $attempts,
                    'available_at' => now()->addSeconds($delay),
                    'last_error' => Str::limit($e->getMessage(), 500),
                    'updated_at' => now(),
                ]);

                ($retryable && ! $exhausted) ? $deferred++ : $dead++;
                $parkedGroups[$group] = true;

                // Unreachable cloud: one connect timeout per drain, not one
                // per job — this runs on the desk's only PHP worker.
                if ($e->errorCode === CloudException::UNREACHABLE) {
                    break;
                }
            } catch (Throwable $e) {
                DB::table('cloud_call_queue')->where('id', $entry->id)->update([
                    'status' => 'dead',
                    'attempts' => $attempts,
                    'last_error' => Str::limit($e->getMessage(), 500),
                    'updated_at' => now(),
                ]);
                $dead++;
                $parkedGroups[$group] = true;
            }
        }

        // Applied changes moved cloud truth — pull the mirrors up to date so
        // every desk screen shows the settled state, not the optimistic one.
        if ($touchedSessions !== []) {
            rescue(function () use ($touchedSessions): void {
                $this->sync->syncEntity('game_sessions');
                $this->sync->refreshSeatingFor(null, array_values(array_unique($touchedSessions)));
            }, report: false);
        }

        return [
            'sent' => $sent,
            'deferred' => $deferred,
            'dead' => $dead,
            'pending' => (int) DB::table('cloud_call_queue')->where('status', 'pending')->count(),
        ];
    }

    /**
     * What the operator's queue panel shows: how much is on the way, and
     * every dead job with its reason.
     *
     * @return array{pending: int, dead: int, dead_items: list<array<string, mixed>>}
     */
    public function status(): array
    {
        return [
            'pending' => (int) DB::table('cloud_call_queue')->whereIn('status', ['pending', 'sending'])->count(),
            'dead' => (int) DB::table('cloud_call_queue')->where('status', 'dead')->count(),
            'dead_items' => DB::table('cloud_call_queue')
                ->where('status', 'dead')
                ->orderByDesc('id')
                ->limit(10)
                ->get(['id', 'label', 'last_error', 'attempts', 'updated_at'])
                ->map(fn (object $row): array => [
                    'id' => (int) $row->id,
                    'label' => $row->label,
                    'last_error' => $row->last_error,
                    'attempts' => (int) $row->attempts,
                    'updated_at' => (string) $row->updated_at,
                ])
                ->all(),
        ];
    }

    /** Put a dead job back in line (front of its group, original order). */
    public function retry(int $id): bool
    {
        $updated = DB::table('cloud_call_queue')
            ->where('id', $id)
            ->where('status', 'dead')
            ->update([
                'status' => 'pending',
                'attempts' => 0,
                'available_at' => now(),
                'last_error' => null,
                'updated_at' => now(),
            ]);

        if ($updated > 0) {
            rescue(fn (): array => $this->drain(8), report: false);
        }

        return $updated > 0;
    }

    /** Drop a dead job for good — the operator has decided it is wrong. */
    public function discard(int $id): bool
    {
        return DB::table('cloud_call_queue')->where('id', $id)->where('status', 'dead')->delete() > 0;
    }

    private function markSent(int $id, int $attempts, ?string $note = null): void
    {
        DB::table('cloud_call_queue')->where('id', $id)->update([
            'status' => 'sent',
            'attempts' => $attempts,
            'sent_at' => now(),
            'last_error' => $note,
            'updated_at' => now(),
        ]);
    }

    /** @param array<int, int> $sessions */
    private function rememberSession(array &$sessions, ?string $groupKey): void
    {
        if ($groupKey !== null && str_starts_with($groupKey, 'session:')) {
            $sessions[] = (int) substr($groupKey, 8);
        }
    }
}
