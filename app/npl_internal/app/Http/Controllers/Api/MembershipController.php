<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudException;
use App\Services\Players\PlayerResolver;
use App\Services\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * Club Membership IDs: the venue's own member register. Writes apply to
 * the mirror NOW and ride the cloud call queue (licence-gated there) —
 * the register works offline, and the next successful re-mirror replaces
 * optimistic rows with the cloud's settled copy.
 */
final class MembershipController extends Controller
{
    public function __construct(
        private readonly CloudCallQueue $queue,
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

    /**
     * Create or edit. Submit → queue → backend: the mirror row updates NOW
     * (scans and the register show it instantly, offline included), the
     * cloud write rides the queue, and the next successful re-mirror
     * replaces the optimistic row with the cloud's settled copy.
     */
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

        $venueId = (int) $validated['venue_id'];
        $nplId = mb_strtoupper(trim((string) $validated['npl_id']));

        $existing = DB::table('mirror_club_memberships')
            ->where('venue_id', $venueId)
            ->whereRaw('UPPER(npl_id) = ?', [$nplId])
            ->first();

        $row = [
            'club_member_code' => (string) $validated['club_member_code'],
            'status' => (string) ($validated['status'] ?? 'active'),
            'valid' => ($validated['status'] ?? 'active') === 'active',
            'joined_at' => $validated['joined_at'] ?? null,
            'expires_at' => $validated['expires_at'] ?? null,
            'notes' => $validated['notes'] ?? null,
            'updated_at' => now(),
        ];

        if ($existing !== null) {
            DB::table('mirror_club_memberships')->where('id', $existing->id)->update($row);
        } else {
            $player = DB::table('mirror_players')->whereRaw('UPPER(npl_id) = ?', [$nplId])->first();

            DB::table('mirror_club_memberships')->insert($row + [
                // Negative temp id, same convention as queued staff
                // comments: replaced by the cloud's real id on re-mirror.
                'cloud_id' => -time(),
                'venue_id' => $venueId,
                'player_id' => null,
                'npl_id' => $nplId,
                'display_name' => $player?->display_name,
                'created_at' => now(),
            ]);
        }

        $this->queue->enqueue('post', '/api/v1/internal/club-memberships', $validated, [
            'group' => 'membership:'.$venueId,
            'label' => 'Club ID '.$validated['club_member_code'].' — '.$nplId,
        ]);

        return $this->ok([
            'result' => ['queued' => true],
            'memberships' => $this->mirrorRows($venueId),
        ]);
    }

    public function destroy(Request $request, int $cloudId): JsonResponse
    {
        $validated = $request->validate([
            'venue_id' => ['required', 'integer', 'min:1'],
        ]);

        $venueId = (int) $validated['venue_id'];

        $existing = DB::table('mirror_club_memberships')
            ->where('venue_id', $venueId)
            ->where('cloud_id', $cloudId)
            ->first();

        DB::table('mirror_club_memberships')
            ->where('venue_id', $venueId)
            ->where('cloud_id', $cloudId)
            ->delete();

        // A negative id is one of OUR still-queued creates — cancel the
        // queued write instead of asking the cloud to delete a row it
        // never received (otherwise the create would land on reconnect
        // and resurrect the membership).
        if ($cloudId < 0) {
            $nplId = mb_strtoupper(trim((string) ($existing->npl_id ?? '')));

            DB::table('cloud_call_queue')
                ->where('status', 'pending')
                ->where('group_key', 'membership:'.$venueId)
                ->where('method', 'post')
                ->where('path', '/api/v1/internal/club-memberships')
                ->get(['id', 'payload'])
                ->filter(fn (object $job): bool => mb_strtoupper(trim((string) (json_decode((string) $job->payload, true)['npl_id'] ?? ''))) === $nplId)
                ->each(fn (object $job) => DB::table('cloud_call_queue')->where('id', $job->id)->delete());

            return $this->ok([
                'result' => ['queued' => false, 'cancelled' => true],
                'memberships' => $this->mirrorRows($venueId),
            ]);
        }

        $this->queue->enqueue('delete', '/api/v1/internal/club-memberships/'.$cloudId, null, [
            'group' => 'membership:'.$venueId,
            'label' => 'Remove club ID #'.$cloudId,
            'tolerate_missing' => true,
        ]);

        return $this->ok([
            'result' => ['queued' => true],
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
