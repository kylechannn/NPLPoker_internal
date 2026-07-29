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
    Route::post('pull-sessions', 'pullSessions');
    Route::get('realtime', 'realtime');
    Route::get('runs/latest', 'latest');
    Route::get('runs/{uuid}', 'status');
    Route::get('snapshot', 'snapshot');
    Route::post('avatars', 'avatars');
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

/*
 * The Jackpot Wheel: composition from the local mirror, spins proxied live
 * to the cloud (only the cloud draws and awards).
 */
Route::prefix('v1/wheel')->controller(\App\Http\Controllers\Api\WheelController::class)->group(function (): void {
    Route::get('/', 'segments');
    Route::post('lookup', 'lookup');
    Route::post('spin', 'spin');
});

// Entry-voucher hooks for the desk: live cloud checks, never mirrored.
Route::prefix('v1/vouchers')->controller(\App\Http\Controllers\Api\WheelController::class)->group(function (): void {
    Route::post('entitlement', 'voucherEntitlement');
    Route::post('redeem', 'voucherRedeem');
});

/**
 * The operator's desk. Split from the clock routes because the desk is a
 * different station: the scanner at the door, not the director's screen.
 */
Route::prefix('v1/desk')->controller(\App\Http\Controllers\Api\DeskController::class)->group(function (): void {
    Route::get('venues', 'venues');
    Route::get('dashboard', 'dashboard');
    Route::get('upcoming-sessions', 'upcomingSessions');
    Route::get('sessions/{gameSessionId}/roster', 'sessionRoster')->whereNumber('gameSessionId');
    Route::delete('sessions/{gameSessionId}/tables/{tableNumber}', 'cancelCloudTable')->whereNumber('gameSessionId')->whereNumber('tableNumber');
    Route::delete('sessions/{gameSessionId}/registrations/{nplId}', 'removeCloudRegistration')->whereNumber('gameSessionId');
    Route::post('structure-preview', 'previewStructure');

    Route::post('{id}/scan', 'scan')->whereNumber('id');
    Route::post('{id}/act', 'act')->whereNumber('id');
    Route::get('{id}/seating', 'seating')->whereNumber('id');
    Route::get('{id}/gates', 'gates')->whereNumber('id');
    Route::post('{id}/eliminate', 'eliminate')->whereNumber('id');
    Route::post('{id}/reinstate', 'reinstate')->whereNumber('id');
    Route::post('{id}/seat', 'seat')->whereNumber('id');
    Route::post('{id}/tables', 'createTable')->whereNumber('id');
    Route::post('{id}/finalise', 'finalise')->whereNumber('id');
    Route::post('{id}/remove-player', 'removePlayer')->whereNumber('id');
});
