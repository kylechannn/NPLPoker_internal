<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Players\PlayerResolver;
use App\Services\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Club Membership IDs: the venue's own member register. Every write goes
 * straight to the NPL cloud (licence-gated there) and the local mirror is
 * rewritten from the cloud's answer — the desk never invents state.
 * Offline, the register is read-only from the last synced copy.
 */
final class MembershipController extends Controller
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly SyncService $sync,
    ) {}

    /** The register: cloud-fresh when reachable, mirror otherwise. */
    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['required', 'integer', 'min:1'],
        ]);

        $venueId = (int) $validated['venue_id'];
        $source = 'cloud';

        try {
            $this->sync->refreshClubMemberships($venueId);
        } catch (CloudException) {
            $source = 'mirror';
        }

        return $this->ok([
            'source' => $source,
            'memberships' => $this->mirrorRows($venueId),
        ]);
    }

    /** Scan/type a card or NPL ID: who is this, and do they hold a club ID? */
    public function resolve(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['required', 'integer', 'min:1'],
            'id' => ['required', 'string', 'max:60'],
        ]);

        $player = app(PlayerResolver::class)->resolve((string) $validated['id']);

        if ($player === null) {
            return response()->json([
                'ok' => false,
                'error' => ['message' => 'No player matches that card number or NPL ID. If they registered seconds ago, try again.'],
            ], 422);
        }

        $membership = DB::table('mirror_club_memberships')
            ->where('venue_id', (int) $validated['venue_id'])
            ->whereRaw('UPPER(npl_id) = ?', [strtoupper((string) $player->npl_id)])
            ->first();

        return $this->ok([
            'player' => [
                'npl_id' => $player->npl_id,
                'display_name' => $player->display_name ?: trim($player->first_name.' '.$player->last_name),
                'state_code' => $player->state_code,
            ],
            'membership' => $membership,
        ]);
    }

    /** Create or edit — straight to the cloud, then re-mirror. */
    public function upsert(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['required', 'integer', 'min:1'],
            'npl_id' => ['required', 'string', 'max:60'],
            'club_member_code' => ['required', 'string', 'max:100'],
            'status' => ['sometimes', 'nullable', Rule::in(['active', 'inactive', 'expired'])],
            'joined_at' => ['sometimes', 'nullable', 'date'],
            'expires_at' => ['sometimes', 'nullable', 'date'],
            'notes' => ['sometimes', 'nullable', 'string', 'max:2000'],
        ]);

        return $this->cloudWrite(
            fn (): array => $this->cloud->postJson('/api/v1/internal/club-memberships', $validated),
            (int) $validated['venue_id'],
        );
    }

    public function destroy(Request $request, int $cloudId): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['required', 'integer', 'min:1'],
        ]);

        return $this->cloudWrite(
            fn (): array => $this->cloud->deleteJson('/api/v1/internal/club-memberships/'.$cloudId),
            (int) $validated['venue_id'],
        );
    }

    private function cloudWrite(callable $call, int $venueId): JsonResponse
    {
        try {
            $result = $call();
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — club IDs need a connection. Try again when the link is green.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        try {
            $this->sync->refreshClubMemberships($venueId);
        } catch (\Throwable) {
            // The next tab load re-mirrors; the cloud write already landed.
        }

        return $this->ok([
            'result' => $result['data'] ?? $result,
            'memberships' => $this->mirrorRows($venueId),
        ]);
    }

    private function mirrorRows(int $venueId): array
    {
        return DB::table('mirror_club_memberships')
            ->where('venue_id', $venueId)
            ->orderBy('club_member_code')
            ->get()
            ->all();
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
