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

        // Eligibility is the cloud's call (it may be gated to jackpot desk
        // entries). Unreachable cloud → unknown; the spin itself will speak.
        $eligibility = null;

        try {
            $result = $this->cloud->getJson('/api/v1/internal/wheel/eligibility', [
                'npl_id' => (string) $player->npl_id,
            ]);
            $eligibility = (array) ($result['data'] ?? []);
        } catch (CloudException) {
            // Leave it unknown.
        }

        return $this->ok([
            'player' => [
                'npl_id' => $player->npl_id,
                'display_name' => $player->display_name ?: trim($player->first_name.' '.$player->last_name),
                'avatar_media_key' => $player->avatar_media_key ?? null,
                'state_code' => $player->state_code,
            ],
            'eligibility' => $eligibility,
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
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->postJson('/api/v1/internal/wheel/spins', [
                'reference' => $validated['reference'],
                'npl_id' => trim($validated['npl_id']),
                'venue_id' => $validated['venue_id'] ?? null,
                'game_session_id' => $validated['game_session_id'] ?? null,
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

    /**
     * Desk scan hook: does this player hold an entry voucher usable here?
     * A live cloud question — voucher truth never mirrors locally, or two
     * desks could each accept the same last use.
     */
    public function voucherEntitlement(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:32'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->getJson('/api/v1/internal/vouchers/entitlement', array_filter([
                'npl_id' => trim($validated['npl_id']),
                'venue_id' => $validated['venue_id'] ?? null,
            ], fn ($value): bool => $value !== null));
        } catch (CloudException) {
            // Offline is not an error at the desk — the prompt just does not
            // appear and the normal fee flow continues untouched.
            return $this->ok(['entitled' => false, 'voucher' => null, 'offline' => true]);
        }

        $data = (array) ($result['data'] ?? []);

        return $this->ok([
            'entitled' => (bool) ($data['entitled'] ?? false),
            'voucher' => $data['voucher'] ?? null,
            'offline' => false,
        ]);
    }

    /** One-tap apply: consume the use in the cloud, idempotent by reference. */
    public function voucherRedeem(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'reference' => ['required', 'string', 'min:8', 'max:64'],
            'npl_id' => ['required', 'string', 'max:32'],
            'voucher_id' => ['sometimes', 'nullable', 'integer'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->postJson('/api/v1/internal/vouchers/redeem', [
                'reference' => $validated['reference'],
                'npl_id' => trim($validated['npl_id']),
                'voucher_id' => $validated['voucher_id'] ?? null,
                'venue_id' => $validated['venue_id'] ?? null,
            ], $validated['reference']);
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => [
                    'code' => $e->errorCode,
                    'message' => $e->errorCode === CloudException::UNREACHABLE
                        ? 'The NPL cloud could not be reached — the voucher was NOT used. Charge the normal fee or retry.'
                        : $e->getMessage(),
                ],
            ], 502);
        }

        return $this->ok(['voucher' => $result['voucher'] ?? null]);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
