<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The venue's real Jackpot Wheel.
 *
 * The composition (segments + odds) comes from the local mirror filled by
 * Manual update; the SPIN is a live call to the cloud — only the cloud may
 * draw a winner and award the prize, so the desk must be online to spin.
 * The operator scans the player first, exactly like registration.
 */
final class WheelController extends Controller
{
    public function __construct(private readonly CloudClient $cloud) {}

    /** The wheel as last pulled by Manual update. */
    public function segments(): JsonResponse
    {
        $rows = DB::table('mirror_wheel_prizes')->orderBy('sort_order')->orderBy('cloud_id')->get();
        $totalWeight = max(1, (int) $rows->sum('weight'));

        return $this->ok([
            'segments' => $rows->values()->map(fn (object $row, int $index): array => [
                'id' => (int) $row->cloud_id,
                'segment_index' => $index,
                'label' => $row->label,
                'lines' => [$row->line_one, $row->line_two],
                'hue' => $row->hue,
                'weight' => (int) $row->weight,
                'weight_percent' => (int) round($row->weight / $totalWeight * 100),
                'benefit_type' => $row->benefit_type,
                'voucher_type' => $row->voucher_type,
                'points_amount' => $row->points_amount !== null ? (int) $row->points_amount : null,
            ])->all(),
        ]);
    }

    /** Scan gate: resolve the player who is about to spin. */
    public function lookup(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:32'],
        ]);

        $player = DB::table('mirror_players')
            ->whereRaw('UPPER(npl_id) = ?', [Str::upper(trim($validated['npl_id']))])
            ->first();

        if (! $player || $player->status !== 'active') {
            return response()->json([
                'ok' => false,
                'error' => ['message' => $player === null
                    ? 'No player was found for this NPL ID. Run a Manual update if they joined recently.'
                    : 'This player is not active and cannot spin.'],
            ], 422);
        }

        return $this->ok([
            'player' => [
                'npl_id' => $player->npl_id,
                'display_name' => $player->display_name ?: trim($player->first_name.' '.$player->last_name),
                'avatar_media_key' => $player->avatar_media_key ?? null,
                'state_code' => $player->state_code,
            ],
        ]);
    }

    /**
     * The real spin — proxied to the cloud, which draws and awards. The UI
     * supplies the reference so its own retry after a dropped connection
     * reuses it and can never double-award.
     */
    public function spin(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'reference' => ['required', 'string', 'min:8', 'max:64'],
            'npl_id' => ['required', 'string', 'max:32'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->postJson('/api/v1/internal/wheel/spins', [
                'reference' => $validated['reference'],
                'npl_id' => trim($validated['npl_id']),
                'venue_id' => $validated['venue_id'] ?? null,
            ], $validated['reference']);
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — the wheel needs a connection to award real prizes. Nothing was drawn.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        return $this->ok(['spin' => $result]);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
