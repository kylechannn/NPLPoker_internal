<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Export tab's data: finished-game summaries + attendance, straight
 * from the cloud's book of record via the licensed feed. Reading the local
 * database would lie after a reinstall — so this never does.
 */
final class ReportProxyController extends Controller
{
    public function __construct(private readonly CloudClient $cloud) {}

    public function index(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'from' => ['sometimes', 'nullable', 'date_format:Y-m-d'],
            'to' => ['sometimes', 'nullable', 'date_format:Y-m-d'],
            'game_type' => ['sometimes', 'nullable', 'in:tournament,cash'],
        ]);

        try {
            $result = $this->cloud->getJson('/api/v1/internal/reports/sessions', array_filter([
                'from' => $validated['from'] ?? null,
                'to' => $validated['to'] ?? null,
                'game_type' => $validated['game_type'] ?? null,
            ], fn ($value): bool => $value !== null && $value !== ''));
        } catch (CloudException $e) {
            return $this->cloudDown($e);
        }

        return $this->ok(['data' => $result['data']['data'] ?? []]);
    }

    public function show(Request $request, string $uid): JsonResponse
    {
        try {
            $result = $this->cloud->getJson('/api/v1/internal/reports/sessions/'.rawurlencode($uid));
        } catch (CloudException $e) {
            return $this->cloudDown($e);
        }

        return $this->ok([
            'report' => $result['data']['report'] ?? null,
            'attendance' => $result['data']['attendance'] ?? [],
        ]);
    }

    private function cloudDown(CloudException $e): JsonResponse
    {
        return response()->json([
            'ok' => false,
            'error' => [
                'code' => $e->errorCode,
                'message' => $e->errorCode === CloudException::UNREACHABLE
                    ? 'The NPL cloud could not be reached — reports live on the cloud, try again when the connection returns.'
                    : $e->getMessage(),
            ],
        ], 502);
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
