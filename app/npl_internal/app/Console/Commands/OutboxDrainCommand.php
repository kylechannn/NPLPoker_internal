<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Sync\OutboxService;
use Illuminate\Console\Command;

/**
 * Pushes pending outbox entries (jackpot entries, later seat moves and
 * buy-ins) to the cloud. Scheduled every fifteen seconds; also runs inline
 * after a jackpot entry so a player can walk straight from the desk to the
 * wheel.
 */
final class OutboxDrainCommand extends Command
{
    protected $signature = 'outbox:drain {--limit= : Maximum entries to push in one pass}';

    protected $description = 'Push pending sync_outbox entries to the cloud.';

    public function handle(OutboxService $outbox): int
    {
        $limit = $this->option('limit');
        $result = $outbox->drain($limit !== null ? (int) $limit : null);

        $this->info(sprintf(
            'Outbox: %d sent, %d failed, %d dead, %d remaining.',
            $result['sent'],
            $result['failed'],
            $result['dead'],
            $result['remaining'],
        ));

        return self::SUCCESS;
    }
}
