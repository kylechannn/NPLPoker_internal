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

    /** The wheel as last pulled by Manual update — one tier at a time. */
    public function segments(Request $request): JsonResponse
    {
        $wheel = $request->query('wheel') === 'golden' ? 'golden' : 'normal';

        $rows = DB::table('mirror_wheel_prizes')
            ->where('wheel', $wheel)
            ->orderBy('sort_order')
            ->orderBy('cloud_id')
            ->get();
        $totalWeight = max(1, (int) $rows->sum('weight'));

        return $this->ok([
            'wheel' => $wheel,
            'segments' => $rows->values()->map(fn (object $row, int $index): array => [
                'id' => (int) $row->cloud_id,
                'segment_index' => $index,
                'wheel' => $row->wheel,
                'label' => $row->label,
                'lines' => [$row->line_one, $row->line_two],
                'hue' => $row->hue,
                'weight' => (int) $row->weight,
                'weight_percent' => (int) round($row->weight / $totalWeight * 100),
                'benefit_type' => $row->benefit_type,
                'voucher_type' => $row->voucher_type,
                'points_amount' => $row->points_amount !== null ? (int) $row->points_amount : null,
                'value_cents' => $row->value_cents !== null ? (int) $row->value_cents : null,
            ])->all(),
        ]);
    }

    /**
     * The live jackpot pool — the same public figure the website and the
     * phone apps show, cached for a minute so the big clock can wear it
     * without hammering the cloud. Offline = last cached value, else null.
     */
    public function pool(): JsonResponse
    {
        $cached = \Illuminate\Support\Facades\Cache::remember('jackpot.pool', 60, function (): ?array {
            try {
                // Through CloudClient — the raw Http call skipped the CA
                // bundle and failed TLS on venue machines (no pool shown).
                $result = $this->cloud->getJson('/api/v1/content/jackpot');
                $data = (array) ($result['data'] ?? []);

                return [
                    'amount_cents' => isset($data['amount_cents']) && $data['amount_cents'] !== null
                        ? (int) $data['amount_cents']
                        : null,
                ];
            } catch (\Throwable) {
                return null;
            }
        });

        return $this->ok(['pool' => $cached]);
    }

    /** Scan gate: resolve the player who is about to spin. */
    public function lookup(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'npl_id' => ['required', 'string', 'max:32'],
        ]);

        // Card number or NPL ID, mirror-first with live cloud fallback —
        // the same resolution as the tournament desk.
        $player = app(\App\Services\Players\PlayerResolver::class)->resolve((string) $validated['npl_id']);

        if (! $player || $player->status !== 'active') {
            return response()->json([
                'ok' => false,
                'error' => ['message' => $player === null
                    ? 'No player matches that card number or NPL ID. If they registered seconds ago, scan again.'
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
            // Golden follow-up draw, funded by the normal spin that landed
            // on the golden segment.
            'wheel' => ['sometimes', 'in:normal,golden'],
            'parent_reference' => ['required_if:wheel,golden', 'nullable', 'string', 'min:8', 'max:61'],
        ]);

        try {
            $result = $this->cloud->postJson('/api/v1/internal/wheel/spins', array_filter([
                'reference' => $validated['reference'],
                'npl_id' => trim($validated['npl_id']),
                'venue_id' => $validated['venue_id'] ?? null,
                'game_session_id' => $validated['game_session_id'] ?? null,
                'wheel' => $validated['wheel'] ?? null,
                'parent_reference' => $validated['parent_reference'] ?? null,
            ], fn ($value): bool => $value !== null), $validated['reference']);
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
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->getJson('/api/v1/internal/vouchers/entitlement', array_filter([
                'npl_id' => trim($validated['npl_id']),
                'venue_id' => $validated['venue_id'] ?? null,
                // The cloud refuses vouchers outright for cash sessions.
                'game_session_id' => $validated['game_session_id'] ?? null,
            ], fn ($value): bool => $value !== null));
        } catch (CloudException) {
            // Offline is not an error at the desk — the prompt just does not
            // appear and the normal fee flow continues untouched.
            return $this->ok(['entitled' => false, 'voucher' => null, 'already_covered' => null, 'offline' => true]);
        }

        $data = (array) ($result['data'] ?? []);

        return $this->ok([
            'entitled' => (bool) ($data['entitled'] ?? false),
            'voucher' => $data['voucher'] ?? null,
            // The player's ONLINE registration already consumed a voucher —
            // the desk must price the entry as paid, not charge again.
            'already_covered' => $data['already_covered'] ?? null,
            // Championship sessions: the player's stackable special tickets
            // and the entry price their values sum against.
            'special_tickets' => $data['special_tickets'] ?? null,
            'entry_fee_cents' => $data['entry_fee_cents'] ?? null,
            // The status-tier window: the player HOLDS a voucher but their
            // tier can't use it this early (Blue 12h / Silver 24h / Gold
            // 48h before start) — the desk shows when it opens.
            'voucher_locked' => (bool) ($data['voucher_locked'] ?? false),
            'voucher_available_from' => $data['voucher_available_from'] ?? null,
            'voucher_tier' => $data['voucher_tier'] ?? null,
            'voucher_tier_hours' => $data['voucher_tier_hours'] ?? null,
            'offline' => false,
        ]);
    }

    /** One-tap apply: consume the use in the cloud, idempotent by reference. */
    public function voucherRedeem(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'reference' => ['required', 'string', 'min:8', 'max:61'],
            'npl_id' => ['required', 'string', 'min:3', 'max:32'],
            'voucher_id' => ['sometimes', 'nullable', 'integer'],
            // A championship ticket stack — several ids, one reference.
            'voucher_ids' => ['sometimes', 'array', 'max:10'],
            'voucher_ids.*' => ['integer', 'min:1'],
            'venue_id' => ['sometimes', 'nullable', 'integer'],
            'game_session_id' => ['sometimes', 'nullable', 'integer'],
        ]);

        try {
            $result = $this->cloud->postJson('/api/v1/internal/vouchers/redeem', array_filter([
                'reference' => $validated['reference'],
                'npl_id' => trim($validated['npl_id']),
                'voucher_id' => $validated['voucher_id'] ?? null,
                'voucher_ids' => $validated['voucher_ids'] ?? null,
                'venue_id' => $validated['venue_id'] ?? null,
                // The cloud refuses vouchers outright for cash sessions.
                'game_session_id' => $validated['game_session_id'] ?? null,
            ], fn ($value): bool => $value !== null), $validated['reference']);
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

        return $this->ok([
            'voucher' => $result['voucher'] ?? null,
            'vouchers' => $result['vouchers'] ?? null,
            'covered_cents' => $result['covered_cents'] ?? null,
        ]);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
