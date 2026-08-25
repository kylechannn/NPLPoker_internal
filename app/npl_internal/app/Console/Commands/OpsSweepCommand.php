<?php

declare(strict_types=1);

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Throwable;

/**
 * The resident sweeper: long-lived processes carrying the sub-minute
 * cadences that used to be schedule entries. schedule:work fired each of
 * those by SPAWNING a fresh php.exe (a full Laravel boot per run, ~20
 * processes a minute on Windows, all day); a resident loop pays the boot
 * once.
 *
 * TWO roles, TWO processes — deliberately: the 5s live-clock broadcast
 * must never queue behind a slow queue drain (a 24-job backlog after an
 * outage can hold a drain pass for minutes, and watching phones would
 * freeze on stale blinds exactly when the venue's network is bad). The
 * Go host runs one process per role and restarts whichever exits —
 * including the deliberate max-runtime exit below, which keeps a week of
 * desk uptime from accumulating any long-run process state.
 *
 * The drains run every few seconds, not 15: web requests no longer drain
 * at all (see CloudCallQueue::drainSoon), so this cadence IS the landing
 * latency for every desk action. An empty pass costs two SELECTs.
 */
final class OpsSweepCommand extends Command
{
    protected $signature = 'ops:sweep
        {--role=all : Which jobs this process carries — broadcast, drains, or all}
        {--max-runtime=3600 : Exit (for a supervised restart) after this many seconds}
        {--once : Run one pass of every job in the role and exit}';

    protected $description = 'Run the sub-minute broadcast and drain cadences in resident processes.';

    private const BROADCAST_EVERY_SECONDS = 5;

    private const DRAIN_EVERY_SECONDS = 3;

    public function handle(): int
    {
        $role = (string) $this->option('role');

        if (! in_array($role, ['broadcast', 'drains', 'all'], true)) {
            $this->error('role must be broadcast, drains, or all.');

            return self::FAILURE;
        }

        $startedAt = microtime(true);
        $maxRuntime = max(60, (int) $this->option('max-runtime'));
        $lastBroadcast = 0.0;
        $lastDrain = 0.0;

        while (true) {
            $now = microtime(true);

            if ($role !== 'drains' && $now - $lastBroadcast >= self::BROADCAST_EVERY_SECONDS) {
                $lastBroadcast = $now;
                $this->tick('tournament:broadcast');
            }

            if ($role !== 'broadcast' && $now - $lastDrain >= self::DRAIN_EVERY_SECONDS) {
                $lastDrain = $now;
                $this->tick('outbox:drain');
                $this->tick('cloud-queue:drain');
            }

            if ($this->option('once')) {
                return self::SUCCESS;
            }

            if (microtime(true) - $startedAt >= $maxRuntime) {
                $this->line('Max runtime reached — exiting for a supervised restart.');

                return self::SUCCESS;
            }

            usleep(1_000_000);
        }
    }

    /** One job, fenced: a failing pass must never take the loop down. */
    private function tick(string $command): void
    {
        try {
            Artisan::call($command);
        } catch (Throwable $e) {
            $this->error(sprintf('%s failed: %s', $command, $e->getMessage()));
        }
    }
}
