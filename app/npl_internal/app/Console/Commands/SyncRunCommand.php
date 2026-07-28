<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Sync\ManualUpdateRunner;
use Illuminate\Console\Command;

/**
 * Executes an already-created run row. This is the detached worker half of
 * the sync API's POST /sync/run — not meant for hand use; `sync:pull` is the
 * human-facing equivalent.
 */
final class SyncRunCommand extends Command
{
    protected $signature = 'sync:run {uuid} {--force : Replace local data even when the cloud reports no change}';

    protected $description = 'Execute a queued manual update run (spawned by the sync API).';

    protected $hidden = true;

    public function handle(ManualUpdateRunner $runner): int
    {
        $run = $runner->run((string) $this->argument('uuid'), (bool) $this->option('force'));

        return in_array($run['status'], ['succeeded', 'partial'], true) ? self::SUCCESS : self::FAILURE;
    }
}
