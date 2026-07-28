<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Services\Tournament\TournamentBroadcaster;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * Keeps the cloud's picture of every live tournament fresh.
 *
 * Clock transitions already publish immediately, so this is the keep-alive:
 * it re-sends running tournaments on a short interval so player counts and
 * average stacks stay current, and so the cloud can tell a venue that went
 * quiet from one that is still hosting. The cloud suppresses pushes that do
 * not change the level, so this costs a phone nothing.
 */
final class TournamentBroadcastCommand extends Command
{
    protected $signature = 'tournament:broadcast {--once : Publish a single pass and exit}';

    protected $description = 'Publish live tournament clocks to the NPL cloud.';

    public function handle(TournamentBroadcaster $broadcaster): int
    {
        $live = DB::table('tournament_sessions')
            ->whereIn('status', ['running', 'paused'])
            ->pluck('id');

        if ($live->isEmpty()) {
            $this->line('No live tournaments.');

            return self::SUCCESS;
        }

        $sent = 0;

        foreach ($live as $id) {
            if ($broadcaster->publish((int) $id)) {
                $sent++;
            }
        }

        $this->info(sprintf('Published %d of %d live tournament(s).', $sent, $live->count()));

        return self::SUCCESS;
    }
}
