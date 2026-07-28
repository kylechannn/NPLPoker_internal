<?php

use Illuminate\Support\Facades\Schedule;

/*
 * While a tournament is live the venue keeps the cloud updated every 15
 * seconds. Transitions (start/pause/level change) publish immediately, so
 * this only carries drift — player counts, average stack, and the liveness
 * signal that tells the cloud this venue is still hosting.
 *
 * Requires `php artisan schedule:work` alongside the app; the Go host runs
 * it as part of the bundle.
 */
Schedule::command('tournament:broadcast')
    ->everyFifteenSeconds()
    ->withoutOverlapping()
    ->runInBackground();

/*
 * Queued local changes (jackpot entries today; seat moves and buy-ins once
 * the operational layer lands) ride to the cloud on the same cadence. The
 * desk also drains inline right after a jackpot entry, so this sweep only
 * carries retries and anything queued while the connection was down.
 */
Schedule::command('outbox:drain')
    ->everyFifteenSeconds()
    ->withoutOverlapping()
    ->runInBackground();
