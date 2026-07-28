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
