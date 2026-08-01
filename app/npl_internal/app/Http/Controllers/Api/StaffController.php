<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The staff register, as Manual update mirrored it. The Go host's QR
 * pairing calls resolve() to turn a typed staff ID into the registered
 * name and role — an unknown or deactivated ID cannot sign in.
 */
final class StaffController extends Controller
{
    public function resolve(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'staff_code' => ['required', 'string', 'min:3', 'max:24'],
        ]);

        $code = Str::upper(trim((string) $validated['staff_code']));

        $row = DB::table('mirror_staff')
            ->whereRaw('UPPER(staff_code) = ?', [$code])
            ->where('status', 'active')
            ->first();

        if ($row === null) {
            $known = DB::table('mirror_staff')->count();

            return response()->json([
                'ok' => false,
                'error' => ['message' => $known === 0
                    ? 'No staff register on this machine yet — run Manual update first, and ask the club admin to add you in the admin console.'
                    : 'This staff ID is not on the register (or was deactivated). Ask the club admin, then run Manual update.'],
            ], 422);
        }

        return response()->json(['ok' => true, 'data' => ['staff' => [
            'staff_code' => $row->staff_code,
            'name' => $row->name,
            'role' => $row->role,
            'venue_id' => $row->venue_id !== null ? (int) $row->venue_id : null,
        ]]]);
    }
}
