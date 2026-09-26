<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Tournament\GameStructureService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Game Structure tab — super admin only on the console, and the cloud
 * enforces the same: a save is made AS THE SIGNED-IN SUPER ADMIN (their
 * own bearer token from the operator sign-in), never with the desk's
 * CD-Key lease. Reads come from the local mirror, refreshed from the
 * cloud whenever it can be reached.
 */
final class GameStructureController extends Controller
{
    public function __construct(
        private readonly GameStructureService $structures,
        private readonly CloudClient $cloud,
    ) {}

    /** The defaults in force on this desk (`?refresh=1` pulls first). */
    public function show(Request $request): JsonResponse
    {
        $refreshed = false;
        $warning = null;

        if ($request->boolean('refresh')) {
            try {
                $this->structures->pull();
                $refreshed = true;
            } catch (CloudException $e) {
                $warning = $e->getMessage();
            }
        }

        return $this->ok($this->structures->all() + ['refreshed' => $refreshed, 'warning' => $warning]);
    }

    /**
     * Best-effort refresh from the cloud — the shell calls this at boot and
     * whenever the sessions hub opens, so a desk about to open a game is
     * on the super admin's latest save. Offline is not an error here: the
     * mirror keeps working.
     */
    public function pull(): JsonResponse
    {
        try {
            $all = $this->structures->pull();
        } catch (CloudException $e) {
            return $this->ok($this->structures->all() + ['refreshed' => false, 'warning' => $e->getMessage()]);
        }

        return $this->ok($all + ['refreshed' => true, 'warning' => null]);
    }

    /** Save to the cloud as the signed-in super admin, then mirror the answer. */
    public function update(Request $request): JsonResponse
    {
        $token = (string) $request->bearerToken();

        if ($token === '') {
            return $this->fail('ADMIN_SIGN_IN_REQUIRED', 'Sign in as a super admin to change the game structure.', 401);
        }

        $validated = $request->validate([
            'tournament' => ['required_without:cash', 'array'],
            'cash' => ['required_without:tournament', 'array'],
        ]);

        try {
            $data = $this->cloud->sendAs('PUT', '/api/v1/admin/os/game-structure', $validated, $token);
        } catch (CloudException $e) {
            if ($e->errorCode === CloudException::UNAUTHORISED) {
                return $e->status === 403
                    ? $this->fail('ADMIN_ROLE_FORBIDDEN', 'Only a super admin can change the game structure.', 403)
                    : $this->fail('ADMIN_SIGN_IN_EXPIRED', 'Your admin sign-in has expired — confirm your password to save.', 401);
            }

            if ($e->errorCode === CloudException::UNREACHABLE) {
                return $this->fail($e->errorCode, 'Could not reach the NPL cloud — the game structure was not saved. Check the venue internet, then try again.', 502);
            }

            // Validation sentences ride the message ("Cut-off must be…").
            $message = (string) preg_replace('/^.*failed \(\d+\): /', '', $e->getMessage());

            return $this->fail($e->errorCode, $message !== '' ? $message : 'The game structure could not be saved.', $e->status === 422 ? 422 : 502);
        }

        $this->structures->store($data);

        return $this->ok($this->structures->all() + ['refreshed' => true, 'warning' => null]);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }

    private function fail(string $code, string $message, int $status): JsonResponse
    {
        return response()->json(['ok' => false, 'error' => ['code' => $code, 'message' => $message]], $status);
    }
}
