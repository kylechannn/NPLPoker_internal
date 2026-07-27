<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Sync\ManualUpdateRunner;
use Illuminate\Console\Command;

/**
 * CLI equivalent of the UI's "Manual Update" button, so a support engineer
 * can run and observe the same pipeline without the desktop app.
 */
final class SyncPullCommand extends Command
{
    protected $signature = 'sync:pull {--force : Replace local data even when the cloud reports no change}';

    protected $description = 'Pull all cloud data and replace the local mirror.';

    public function handle(ManualUpdateRunner $runner): int
    {
        $this->info('Starting manual update…');

        $run = $runner->start('cli');

        $this->table(['Field', 'Value'], [
            ['Status', $run['status']],
            ['Rows written', (string) $run['rows_written']],
            ['Media downloaded', (string) $run['media_downloaded']],
            ['Media skipped', (string) $run['media_skipped']],
            ['Error', (string) ($run['error'] ?? '—')],
        ]);

        foreach ((array) ($run['summary']['entities'] ?? []) as $entity => $result) {
            $this->line(sprintf(
                ' %-16s %-14s %6d rows%s',
                $entity,
                $result['status'] ?? '?',
                (int) ($result['rows'] ?? 0),
                isset($result['message']) && $result['message'] ? '  — '.$result['message'] : '',
            ));
        }

        return in_array($run['status'], ['succeeded', 'partial'], true) ? self::SUCCESS : self::FAILURE;
    }
}
