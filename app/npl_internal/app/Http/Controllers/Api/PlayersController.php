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
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly \App\Services\Cloud\CloudCallQueue $queue,
    ) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'query' => ['sometimes', 'nullable', 'string', 'max:80'],
            'venue_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
        ]);

        $query = strtoupper(trim((string) ($validated['query'] ?? '')));
        $venueId = isset($validated['venue_id']) ? (int) $validated['venue_id'] : null;

        // Per-word matching: every word of the query must land somewhere in
        // the identifiers or names — "West As" finds "West Ashfield", and
        // "Jo Sm" finds John Smith, whatever the word order.
        $tokens = $query !== '' ? (preg_split('/\s+/', $query, -1, PREG_SPLIT_NO_EMPTY) ?: []) : [];

        $players = DB::table('mirror_players')
            ->when($tokens !== [], fn ($builder) => $builder->where(function ($where) use ($tokens) {
                foreach ($tokens as $token) {
                    $like = "%{$token}%";
                    $where->where(fn ($word) => $word
                        ->whereRaw('UPPER(npl_id) LIKE ?', [$like])
                        ->orWhereRaw('UPPER(public_player_code) LIKE ?', [$like])
                        ->orWhereRaw('UPPER(display_name) LIKE ?', [$like])
                        ->orWhereRaw('UPPER(first_name || \' \' || last_name) LIKE ?', [$like]));
                }
            }))
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
                // Imported rows can carry a NULL name — the UI types this
                // as string and slices it; one null used to white-screen
                // the whole console.
                'display_name' => $row->display_name ?? $row->npl_id ?? '',
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

        $comments = (array) ($result['data']['comments'] ?? []);

        // Overlay this desk's queued-but-unsent comment work: queued adds
        // appear (negative ids, pending flag), queued deletes disappear.
        $jobs = \Illuminate\Support\Facades\DB::table('cloud_call_queue')
            ->whereIn('status', ['pending', 'sending'])
            ->where(fn ($query) => $query
                ->where('group_key', 'comments:'.mb_strtoupper(trim((string) $validated['npl_id'])))
                ->orWhere(fn ($del) => $del->where('method', 'delete')->where('path', 'like', '/api/v1/internal/player-comments/%')))
            ->orderByDesc('id')
            ->get(['id', 'method', 'path', 'payload', 'created_at']);

        if ($jobs->isNotEmpty()) {
            $deletedIds = [];
            $pendingAdds = [];

            foreach ($jobs as $job) {
                if ($job->method === 'delete' && preg_match('#/player-comments/(\d+)$#', (string) $job->path, $m)) {
                    $deletedIds[(int) $m[1]] = true;

                    continue;
                }

                if ($job->method === 'post') {
                    $payload = (array) json_decode((string) $job->payload, true);
                    $pendingAdds[] = [
                        // Negative = still on its way; delete resolves
                        // against the queue, not the cloud.
                        'id' => -(int) $job->id,
                        'venue_id' => isset($payload['venue_id']) ? (int) $payload['venue_id'] : null,
                        'venue_name' => null,
                        'author_name' => (string) (($payload['author_name'] ?? null) ?: 'Venue desk'),
                        'note' => (string) ($payload['note'] ?? ''),
                        'created_at' => (string) $job->created_at,
                        'pending' => true,
                    ];
                }
            }

            $comments = array_values(array_filter(
                array_merge($pendingAdds, $comments),
                fn (array $comment): bool => ! isset($deletedIds[(int) ($comment['id'] ?? 0)]),
            ));
        }

        return $this->ok([
            'available' => true,
            'comments' => $comments,
            'truncated' => (bool) ($result['data']['truncated'] ?? false),
        ]);
    }

    /**
     * One call for a whole session roster: which of these players carry
     * staff comments? Fail-open — offline means no popup, never a blocked
     * registration record.
     */
    public function commentsBulk(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_ids' => ['required', 'array', 'min:1', 'max:100'],
            'npl_ids.*' => ['string', 'max:60'],
        ]);

        try {
            $result = $this->cloud->getJson('/api/v1/internal/player-comments', [
                'npl_ids' => implode(',', $validated['npl_ids']),
            ]);
        } catch (CloudException) {
            return $this->ok(['available' => false, 'players' => []]);
        }

        return $this->ok([
            'available' => true,
            'players' => (array) ($result['data']['players'] ?? []),
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

        // Submit → queue → backend: the note shows immediately via the
        // comments() overlay; the cloud write rides the queue.
        $this->queue->enqueue('post', '/api/v1/internal/player-comments', $validated, [
            'group' => 'comments:'.mb_strtoupper(trim((string) $validated['npl_id'])),
            'label' => 'Staff comment on '.$validated['npl_id'],
        ]);

        return $this->ok(['result' => ['queued' => true]]);
    }

    public function destroyComment(int $cloudId): JsonResponse
    {
        // A negative id is one of OUR queued adds — cancel it in place.
        if ($cloudId < 0) {
            \Illuminate\Support\Facades\DB::table('cloud_call_queue')
                ->where('id', -$cloudId)
                ->whereIn('status', ['pending', 'sending'])
                ->delete();

            return $this->ok(['result' => ['queued' => false, 'cancelled' => true]]);
        }

        $this->queue->enqueue('delete', '/api/v1/internal/player-comments/'.$cloudId, null, [
            'label' => 'Remove staff comment #'.$cloudId,
            'tolerate_missing' => true,
        ]);

        return $this->ok(['result' => ['queued' => true]]);
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

        $response = $this->cloudCall(fn (): array => $this->cloud->getJson('/api/v1/internal/players/vouchers', [
            'npl_id' => (string) $validated['npl_id'],
        ]));

        // Queued mark-used jobs flip their voucher to used in the list the
        // operator is looking at, before the cloud has applied them.
        $queuedIds = \Illuminate\Support\Facades\DB::table('cloud_call_queue')
            ->whereIn('status', ['pending', 'sending'])
            ->where('method', 'post')
            ->where('path', 'like', '/api/v1/internal/players/vouchers/%/mark-used')
            ->get(['path'])
            ->map(fn (object $row): ?int => preg_match('#/vouchers/(\d+)/mark-used$#', (string) $row->path, $m) ? (int) $m[1] : null)
            ->filter()
            ->flip();

        if ($queuedIds->isNotEmpty()) {
            $body = $response->getData(true);

            if (isset($body['data']['vouchers']) && is_array($body['data']['vouchers'])) {
                $body['data']['vouchers'] = array_map(
                    function (array $voucher) use ($queuedIds): array {
                        if ($queuedIds->has((int) ($voucher['id'] ?? 0))) {
                            $voucher['status'] = 'used';
                        }

                        return $voucher;
                    },
                    $body['data']['vouchers'],
                );

                return response()->json($body, 200);
            }
        }

        return $response;
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
        // Reference-idempotent on the cloud — safe to queue; the vouchers
        // list overlay shows it used immediately.
        $this->queue->enqueue('post', '/api/v1/internal/players/vouchers/'.$cloudVoucherId.'/mark-used', $request->all(), [
            'label' => 'Mark voucher #'.$cloudVoucherId.' used',
        ]);

        return $this->ok(['result' => ['queued' => true]]);
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
