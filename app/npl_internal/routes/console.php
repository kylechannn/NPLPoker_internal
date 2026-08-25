<?php

use Illuminate\Support\Facades\Schedule;

/*
 * The sub-minute work — the 5s live-clock broadcast and the 15s outbox +
 * cloud-queue drains — does NOT live here any more. As schedule entries,
 * schedule:work spawned a fresh php.exe (a full Laravel boot) for every
 * run: ~20 process launches a minute on a venue laptop, all day. They now
 * ride `ops:sweep`, one resident process the Go host starts beside
 * schedule:work and restarts if it exits. Same cadences, same commands.
 */

/*
 * The stuck-desk safety net: a session nobody pressed Finish on is retired
 * 12 hours after it opened (players inside or not), freeing the one-session
 * slot. The active-session read runs the same sweep lazily, so this cadence
 * only matters when the window is closed.
 */
Schedule::command('tournament:finish-stale')
    ->everyTenMinutes()
    ->withoutOverlapping()
    ->runInBackground();
