<?php

use App\Http\Controllers\Api\MediaController;
use App\Http\Controllers\Api\SyncController;
use Illuminate\Support\Facades\Route;

/*
 * Local API for the NPL internal operational system.
 *
 * No auth middleware by design: the Go host binds the listener to loopback
 * and owns the CD-Key gate, exactly as EdgeHost does. Nothing here is
 * reachable from the LAN unless the host chooses to expose it.
 */

Route::get('/health', function () {
    return response()->json([
        'ok' => true,
        'service' => 'npl-internal-backend',
        'time' => now()->toIso8601String(),
    ]);
});

Route::prefix('v1/sync')->controller(SyncController::class)->group(function (): void {
    Route::get('manifest', 'manifest');
    Route::post('run', 'run');
    Route::get('runs/latest', 'latest');
    Route::get('runs/{uuid}', 'status');
    Route::get('snapshot', 'snapshot');
});

Route::get('/media/{key}', [MediaController::class, 'show'])->where('key', '[A-Za-z0-9]+');
