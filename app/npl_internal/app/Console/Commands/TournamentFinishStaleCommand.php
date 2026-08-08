<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Tournament\TournamentDeskService;
use Illuminate\Console\Command;

/**
 * The stuck-desk safety net: retires sessions left unfinished past the
 * 12-hour mark. The active-session read runs the same sweep lazily whenever
 * the UI is polling; this command covers the machine that sits with the
 * window closed, so the slot is free before the next game night starts.
 */
final class TournamentFinishStaleCommand extends Command
{
    protected $signature = 'tournament:finish-stale';

    protected $description = 'Force-finish sessions left unfinished for 12+ hours.';

    public function handle(TournamentDeskService $desk): int
    {
        $retired = $desk->forceFinishStale();

        if ($retired === 0) {
            $this->line('No stale sessions.');

            return self::SUCCESS;
        }

        $this->info(sprintf('Force-finished %d stale session(s).', $retired));

        return self::SUCCESS;
    }
}
