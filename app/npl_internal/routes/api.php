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
    Route::post('avatars', 'avatars');
});

Route::get('/media/{key}', [MediaController::class, 'show'])->where('key', '[A-Za-z0-9]+');

// Staff register (mirrored by Manual update): the Go host resolves a typed
// staff ID here during QR pairing — unknown IDs cannot sign in.
Route::post('v1/staff/resolve', [\App\Http\Controllers\Api\StaffController::class, 'resolve']);

// The operator gate: the SAME admin account + password as the NPL website.
// Credentials are verified against the cloud; only the identity returns.
Route::post('v1/console/login', [\App\Http\Controllers\Api\ConsoleAuthController::class, 'login']);

// Receipt printing preferences + test receipt (the Overview tab's card).
Route::get('v1/receipts/settings', [\App\Http\Controllers\Api\ReceiptController::class, 'settings']);
Route::post('v1/receipts/settings', [\App\Http\Controllers\Api\ReceiptController::class, 'update']);
Route::post('v1/receipts/test', [\App\Http\Controllers\Api\ReceiptController::class, 'test']);

/*
 * Tournament clock — the poker adaptation of EdgeHost's Sichuan module.
 * The clock is server-authoritative so every display agrees.
 * (Only the routes the UI actually calls exist — the desk endpoints own
 * registration/actions/finish, and templates never grew a UI.)
 */
Route::prefix('v1/tournaments')->controller(\App\Http\Controllers\Api\TournamentController::class)->group(function (): void {
    Route::post('/', 'store');
    // The one unfinished session (with its admin QR) — null when idle.
    // The sidebar polls this; it is also why store() refuses seconds.
    Route::get('active', 'active');
    Route::get('{id}', 'show')->whereNumber('id');
    Route::put('{id}', 'update')->whereNumber('id');
    // Abandon a mistaken draft (no buy-ins yet) — frees the one-session slot.
    Route::delete('{id}', 'destroy')->whereNumber('id');
    // Chips/prize rail text only — allowed while running, unlike update.
    Route::put('{id}/display', 'display')->whereNumber('id');
    // What the iOS admin scanner reads: this session's cloud identity.
    Route::get('{id}/admin-qr', 'adminQr')->whereNumber('id');

    Route::post('{id}/start', 'start')->whereNumber('id');
    Route::post('{id}/pause', 'pause')->whereNumber('id');
    Route::post('{id}/resume', 'resume')->whereNumber('id');
    Route::post('{id}/next-level', 'nextLevel')->whereNumber('id');
    Route::post('{id}/previous-level', 'previousLevel')->whereNumber('id');
});

/*
 * The Jackpot Wheel: composition from the local mirror, spins proxied live
 * to the cloud (only the cloud draws and awards).
 */
Route::prefix('v1/wheel')->controller(\App\Http\Controllers\Api\WheelController::class)->group(function (): void {
    Route::get('/', 'segments');
    Route::get('pool', 'pool');
    Route::post('lookup', 'lookup');
    Route::post('spin', 'spin');
});

// Finished-game reports, read back FROM THE CLOUD (the book of record) —
// the Export tab never trusts the local database for money figures.
Route::prefix('v1/reports')->controller(\App\Http\Controllers\Api\ReportProxyController::class)->group(function (): void {
    Route::get('sessions', 'index');
    Route::get('sessions/{uid}', 'show');
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
    Route::get('upcoming-sessions', 'upcomingSessions');
    Route::get('all-sessions', 'allSessions');
    Route::get('sessions/{gameSessionId}/roster', 'sessionRoster')->whereNumber('gameSessionId');
    Route::get('sessions/{gameSessionId}/online-registrations', 'onlineRegistrations')->whereNumber('gameSessionId');
    Route::delete('sessions/{gameSessionId}/tables/{tableNumber}', 'cancelCloudTable')->whereNumber('gameSessionId')->whereNumber('tableNumber');
    Route::post('sessions/{gameSessionId}/tables/{tableNumber}/stop-countdown', 'stopCloudTableCountdown')->whereNumber('gameSessionId')->whereNumber('tableNumber');
    Route::delete('sessions/{gameSessionId}/registrations/{nplId}', 'removeCloudRegistration')->whereNumber('gameSessionId');
    Route::post('sessions/{gameSessionId}/registrations/{nplId}/promote', 'promoteCloudRegistration')->whereNumber('gameSessionId');
    Route::post('structure-preview', 'previewStructure');
    Route::get('chat/recent', 'chatRecent');

    Route::post('{id}/scan', 'scan')->whereNumber('id');
    Route::post('{id}/act', 'act')->whereNumber('id');
    Route::get('{id}/seating', 'seating')->whereNumber('id');
    // Apply admin-phone rebuys/buy-ins into the local ledger.
    Route::post('{id}/service-sync', 'serviceSync')->whereNumber('id');
    // The desk handles a phone request itself (main control).
    Route::post('{id}/service-handle', 'serviceHandle')->whereNumber('id');
    Route::post('{id}/eliminate', 'eliminate')->whereNumber('id');
    Route::post('{id}/reinstate', 'reinstate')->whereNumber('id');
    Route::post('{id}/seat', 'seat')->whereNumber('id');
    Route::post('{id}/tables', 'createTable')->whereNumber('id');
    Route::post('{id}/finalise', 'finalise')->whereNumber('id');
    Route::post('{id}/remove-player', 'removePlayer')->whereNumber('id');
});

// The desk→cloud call queue: status for the shell's sync badge, plus
// retry/discard on dead jobs.
Route::prefix('v1/cloud-queue')->controller(\App\Http\Controllers\Api\CloudQueueController::class)->group(function (): void {
    Route::get('status', 'status');
    Route::post('outbox/{id}/retry', 'retryOutbox')->whereNumber('id');
    Route::delete('outbox/{id}', 'discardOutbox')->whereNumber('id');
    Route::post('{id}/retry', 'retry')->whereNumber('id');
    Route::delete('{id}', 'discard')->whereNumber('id');
});

// Player operations: roster search, staff comments, desk registration.
Route::prefix('v1/players')->controller(\App\Http\Controllers\Api\PlayersController::class)->group(function (): void {
    Route::get('/', 'index');
    Route::get('comments', 'comments');
    Route::post('comments/bulk', 'commentsBulk');
    Route::post('comments', 'storeComment');
    // Negative ids are this desk's own queued-but-unsent comments.
    Route::delete('comments/{cloudId}', 'destroyComment')->where('cloudId', '-?[0-9]+');
    Route::post('update', 'updatePlayer');
    Route::post('password', 'setPassword');
    Route::get('vouchers', 'vouchers');
    Route::get('activity', 'activity');
    Route::post('vouchers/{cloudVoucherId}/mark-used', 'markVoucherUsed')->whereNumber('cloudVoucherId');
    Route::post('register-code', 'registerCode');
    Route::post('register', 'register');
});

// Club Membership IDs — the venue's own member register, cloud-authoritative.
Route::prefix('v1/membership')->controller(\App\Http\Controllers\Api\MembershipController::class)->group(function (): void {
    Route::get('/', 'index');
    Route::post('resolve', 'resolve');
    Route::post('/', 'upsert');
    // Negative ids are this desk's own queued-but-unsent creates.
    Route::delete('{cloudId}', 'destroy')->where('cloudId', '-?[0-9]+');
});
