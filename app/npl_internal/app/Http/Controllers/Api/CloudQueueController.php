<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudCallQueue;
use Illuminate\Http\JsonResponse;

/**
 * The operator's window into the desk→cloud call queue: how much is on
 * the way, what failed for good, and the two controls that matter —
 * retry and discard.
 */
final class CloudQueueController extends Controller
{
    public function __construct(private readonly CloudCallQueue $queue) {}

    public function status(): JsonResponse
    {
        return $this->ok($this->queue->status());
    }

    public function retry(int $id): JsonResponse
    {
        return $this->ok(['retried' => $this->queue->retry($id)]);
    }

    public function discard(int $id): JsonResponse
    {
        return $this->ok(['discarded' => $this->queue->discard($id)]);
    }
}
