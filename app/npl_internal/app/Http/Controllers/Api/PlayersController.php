<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

/**
 * Player operations at the desk: search the synced roster, read and write
 * staff comments (cloud-stored, licence-attributed), and register a brand
 * new member — the same email verification-code chain as the website, run
 * from the counter. Comments and registration need the link green;
 * searching works offline off the mirror.
 */
final class PlayersController extends Controller
{
    public function __construct(private readonly CloudClient $cloud) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'query' => ['sometimes', 'nullable', 'string', 'max:80'],
            'venue_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
        ]);

        $query = strtoupper(trim((string) ($validated['query'] ?? '')));
        $venueId = isset($validated['venue_id']) ? (int) $validated['venue_id'] : null;

        $players = DB::table('mirror_players')
            ->when($query !== '', fn ($builder) => $builder->where(fn ($where) => $where
                ->whereRaw('UPPER(npl_id) LIKE ?', ["%{$query}%"])
                ->orWhereRaw('UPPER(public_player_code) LIKE ?', ["%{$query}%"])
                ->orWhereRaw('UPPER(display_name) LIKE ?', ["%{$query}%"])
                ->orWhereRaw('UPPER(first_name || \' \' || last_name) LIKE ?', ["%{$query}%"])))
            ->orderBy('display_name')
            ->limit(50)
            ->get();

        $clubIds = $venueId !== null
            ? DB::table('mirror_club_memberships')
                ->where('venue_id', $venueId)
                ->where('valid', true)
                ->pluck('club_member_code', 'npl_id')
                ->mapWithKeys(fn ($code, $npl) => [strtoupper((string) $npl) => $code])
                ->all()
            : null;

        return $this->ok([
            'players' => $players->map(fn (object $row): array => [
                'npl_id' => $row->npl_id,
                'display_name' => $row->display_name,
                'public_player_code' => $row->public_player_code,
                'state_code' => $row->state_code,
                'avatar_media_key' => $row->avatar_media_key,
                'status' => $row->status,
                'club_member_code' => $clubIds !== null ? ($clubIds[strtoupper((string) $row->npl_id)] ?? null) : null,
            ])->values()->all(),
        ]);
    }

    /** Live from the cloud; offline degrades to "unknown", never an error. */
    public function comments(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:60'],
        ]);

        try {
            $result = $this->cloud->getJson('/api/v1/internal/player-comments', [
                'npl_id' => (string) $validated['npl_id'],
            ]);
        } catch (CloudException) {
            return $this->ok(['available' => false, 'comments' => [], 'truncated' => false]);
        }

        return $this->ok([
            'available' => true,
            'comments' => (array) ($result['data']['comments'] ?? []),
            'truncated' => (bool) ($result['data']['truncated'] ?? false),
        ]);
    }

    public function storeComment(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:60'],
            'note' => ['required', 'string', 'max:5000'],
            'author_name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'venue_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
        ]);

        return $this->cloudCall(fn (): array => $this->cloud->postJson('/api/v1/internal/player-comments', $validated));
    }

    public function destroyComment(int $cloudId): JsonResponse
    {
        return $this->cloudCall(fn (): array => $this->cloud->deleteJson('/api/v1/internal/player-comments/'.$cloudId));
    }

    /** Edit details — email included, no verification code by design. */
    public function updatePlayer(Request $request): JsonResponse
    {
        $payload = $request->all();

        $response = $this->cloudCall(fn (): array => $this->cloud->postJson('/api/v1/internal/players/update', $payload));

        // Keep the local roster in step so the next scan shows the edit.
        $data = $response->getData(true);
        $player = $data['data']['result']['player'] ?? null;

        if (is_array($player) && isset($player['npl_id'])) {
            DB::table('mirror_players')
                ->whereRaw('UPPER(npl_id) = ?', [strtoupper((string) $player['npl_id'])])
                ->update([
                    'display_name' => (string) ($player['display_name'] ?? $player['npl_id']),
                    'first_name' => $player['first_name'] ?? null,
                    'last_name' => $player['last_name'] ?? null,
                    'state_code' => $player['state_code'] ?? null,
                    'updated_at' => now(),
                ]);
        }

        return $response;
    }

    public function setPassword(Request $request): JsonResponse
    {
        return $this->cloudCall(fn (): array => $this->cloud->postJson('/api/v1/internal/players/password', $request->all()));
    }

    public function vouchers(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:60'],
        ]);

        return $this->cloudCall(fn (): array => $this->cloud->getJson('/api/v1/internal/players/vouchers', [
            'npl_id' => (string) $validated['npl_id'],
        ]));
    }

    /**
     * The player's venue activity — recent sessions with money and
     * placement, straight from the cloud's book of record.
     */
    public function activity(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:60'],
        ]);

        return $this->cloudCall(fn (): array => $this->cloud->getJson('/api/v1/internal/players/activity', [
            'npl_id' => (string) $validated['npl_id'],
        ]));
    }

    public function markVoucherUsed(Request $request, int $cloudVoucherId): JsonResponse
    {
        return $this->cloudCall(fn (): array => $this->cloud->postJson(
            '/api/v1/internal/players/vouchers/'.$cloudVoucherId.'/mark-used',
            $request->all(),
        ));
    }

    public function registerCode(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'email' => ['required', 'email', 'max:160'],
        ]);

        return $this->cloudCall(fn (): array => $this->cloud->postJson('/api/v1/internal/players/register-code', $validated));
    }

    public function register(Request $request): JsonResponse
    {
        $payload = $request->all();

        $response = $this->cloudCall(fn (): array => $this->cloud->postJson('/api/v1/internal/players/register', $payload));

        // Mirror the new member instantly so the very next scan finds them
        // without waiting for a sync cycle.
        $data = $response->getData(true);
        $player = $data['data']['result']['player'] ?? null;

        if (is_array($player) && isset($player['id'], $player['npl_id'])) {
            DB::table('mirror_players')->updateOrInsert(
                ['cloud_id' => (int) $player['id']],
                [
                    'npl_id' => (string) $player['npl_id'],
                    'public_player_code' => $player['public_player_code'] ?? null,
                    'display_name' => (string) ($player['display_name'] ?? $player['npl_id']),
                    'first_name' => $player['first_name'] ?? null,
                    'last_name' => $player['last_name'] ?? null,
                    'state_code' => $player['state_code'] ?? null,
                    'status' => (string) ($player['status'] ?? 'active'),
                    'updated_at' => now(),
                    'created_at' => now(),
                ],
            );
        }

        return $response;
    }

    private function cloudCall(callable $call): JsonResponse
    {
        try {
            $result = $call();
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — this needs a connection. Try again when the link is green.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        return $this->ok(['result' => $result['data'] ?? $result]);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
