<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Cloud\CloudCallQueue;
use Illuminate\Console\Command;

/**
 * Pushes queued desk→cloud calls (registration removals, promotions,
 * table cancels, comments…). The desk drains inline right after each
 * enqueue, so this sweep only carries retries and anything queued while
 * the connection was down.
 */
final class CloudQueueDrainCommand extends Command
{
    protected $signature = 'cloud-queue:drain {--limit= : Maximum jobs to push in one pass}';

    protected $description = 'Push pending cloud_call_queue jobs to the cloud.';

    public function handle(CloudCallQueue $queue): int
    {
        $limit = $this->option('limit');
        $result = $queue->drain($limit !== null ? (int) $limit : null);

        $this->info(sprintf(
            'sent=%d deferred=%d dead=%d pending=%d',
            $result['sent'],
            $result['deferred'],
            $result['dead'],
            $result['pending'],
        ));

        return self::SUCCESS;
    }
}
