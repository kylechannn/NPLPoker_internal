<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;

/**
 * The liveness answer the Go host polls while booting the bundled app.
 * A controller rather than a route closure, because closures cannot be
 * route:cached — and the host runs `artisan optimize` at boot.
 */
final class HealthController extends Controller
{
    public function __invoke(): JsonResponse
    {
        return response()->json([
            'ok' => true,
            'service' => 'npl-internal-backend',
            'time' => now()->toIso8601String(),
        ]);
    }
}
