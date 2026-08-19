<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudLinkState;
use Illuminate\Http\JsonResponse;

/**
 * The operator's window into the desk→cloud call queue: how much is on
 * the way, what failed for good, and the two controls that matter —
 * retry and discard.
 */
final class CloudQueueController extends Controller
{
    public function __construct(
        private readonly CloudCallQueue $queue,
        private readonly CloudLinkState $link,
    ) {}

    public function status(): JsonResponse
    {
        // The UI polls this every 15s while visible — that poll doubles as
        // the recovery probe, so an operator watching the chip sees the
        // link come back (and the queues release) without waiting for the
        // scheduled sweep.
        $this->link->probeIfDue();

        $status = $this->queue->status();
        $status['link'] = $this->link->snapshot();

        // The money outbox (jackpot entries, finish reports) shares the
        // panel: its dead letters are the ones that MUST get eyes.
        $status['outbox_dead'] = \Illuminate\Support\Facades\DB::table('sync_outbox')
            ->where('status', 'dead')
            ->orderByDesc('id')
            ->limit(10)
            ->get(['id', 'entity_type', 'operation', 'last_error', 'attempts', 'updated_at'])
            ->map(fn (object $row): array => [
                'id' => (int) $row->id,
                'label' => str_replace('_', ' ', (string) $row->entity_type).' ('.$row->operation.')',
                'last_error' => $row->last_error,
                'attempts' => (int) $row->attempts,
                'updated_at' => (string) $row->updated_at,
            ])
            ->all();
        $status['outbox_dead_count'] = (int) \Illuminate\Support\Facades\DB::table('sync_outbox')->where('status', 'dead')->count();

        return $this->ok($status);
    }

    public function retryOutbox(int $id): JsonResponse
    {
        $updated = \Illuminate\Support\Facades\DB::table('sync_outbox')
            ->where('id', $id)
            ->where('status', 'dead')
            ->update(['status' => 'pending', 'attempts' => 0, 'available_at' => now(), 'last_error' => null, 'updated_at' => now()]);

        return $this->ok(['retried' => $updated > 0]);
    }

    public function discardOutbox(int $id): JsonResponse
    {
        $deleted = \Illuminate\Support\Facades\DB::table('sync_outbox')
            ->where('id', $id)
            ->where('status', 'dead')
            ->delete();

        return $this->ok(['discarded' => $deleted > 0]);
    }

    public function retry(int $id): JsonResponse
    {
        return $this->ok(['retried' => $this->queue->retry($id)]);
    }

    public function discard(int $id): JsonResponse
    {
        return $this->ok(['discarded' => $this->queue->discard($id)]);
    }

    // Every controller here answers the same envelope; this one always
    // called $this->ok() but never had it — all five endpoints fatalled
    // and the shell's "status is cosmetic" catch swallowed the 500s.
    private function ok(array $data, int $status = 200): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data], $status);
    }
}
