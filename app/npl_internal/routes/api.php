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

/*
 * Tournament clock — the poker adaptation of EdgeHost's Sichuan module.
 * The clock is server-authoritative so every display agrees.
 */
Route::prefix('v1/tournament-templates')->controller(\App\Http\Controllers\Api\TournamentController::class)->group(function (): void {
    Route::get('/', 'templates');
    Route::post('/', 'saveTemplate');
    Route::delete('{templateId}', 'deleteTemplate')->whereNumber('templateId');
});

Route::prefix('v1/tournaments')->controller(\App\Http\Controllers\Api\TournamentController::class)->group(function (): void {
    Route::get('/', 'index');
    Route::post('/', 'store');
    Route::get('{id}', 'show')->whereNumber('id');
    Route::put('{id}/structure', 'updateStructure')->whereNumber('id');

    Route::get('{id}/clock', 'clock')->whereNumber('id');
    Route::post('{id}/start', 'start')->whereNumber('id');
    Route::post('{id}/pause', 'pause')->whereNumber('id');
    Route::post('{id}/resume', 'resume')->whereNumber('id');
    Route::post('{id}/next-level', 'nextLevel')->whereNumber('id');
    Route::post('{id}/previous-level', 'previousLevel')->whereNumber('id');
    Route::post('{id}/adjust-time', 'adjustTime')->whereNumber('id');
    Route::post('{id}/finish', 'finish')->whereNumber('id');

    Route::get('{id}/players', 'players')->whereNumber('id');
    Route::post('{id}/register', 'register')->whereNumber('id');
    Route::post('{id}/actions', 'act')->whereNumber('id');
});
