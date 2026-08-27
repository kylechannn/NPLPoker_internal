<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudClient;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Feedback & Reports: bug reports, feedback and feature requests from the
 * venue desk to NPL head office, read back in the website admin console.
 *
 * Sending rides the cloud call queue — a report typed during an outage is
 * never lost, it lands the moment the link is green and the queue panel
 * shows it on the way. Reading is live from the cloud (status, the admin's
 * reply), with this desk's still-queued reports listed alongside so the
 * operator sees everything they have sent, delivered or not.
 */
final class FeedbackController extends Controller
{
    /** The licensed cloud endpoint both the queue job and the feed hit. */
    private const CLOUD_PATH = '/api/v1/internal/feedback';

    /**
     * The cloud refuses a context blob above this many JSON bytes. Checked
     * HERE, before queueing, so an oversized diagnostics attachment is a
     * 422 on the operator's screen — not a dead-lettered job hours later.
     */
    private const CONTEXT_MAX_BYTES = 16000;

    public function __construct(
        private readonly CloudClient $cloud,
        private readonly CloudCallQueue $queue,
    ) {}

    /**
     * What this licence has sent, newest first, plus what is still on its
     * way. Offline degrades to available:false with the queued rows only —
     * never an error, the operator can still send.
     */
    public function index(): JsonResponse
    {
        $available = true;
        $reports = [];

        try {
            $result = $this->cloud->getJson(self::CLOUD_PATH, ['limit' => 50]);
            $reports = array_values((array) ($result['data']['reports'] ?? []));
        } catch (Throwable) {
            // A typed CloudException (offline, unlicensed, a 5xx) and a
            // driver-level failure the client did not classify all read
            // the same here: the queued list below is still the useful
            // part of this screen, and the operator can still send.
            $available = false;
        }

        return $this->ok([
            'available' => $available,
            'reports' => $reports,
            'pending' => $this->pending(),
        ]);
    }

    /**
     * Submit → queue → backend. The client reference is minted here so a
     * retried job is idempotent on the cloud (the same report never lands
     * twice), and the OS build is stamped from config so head office knows
     * which version the venue was running.
     */
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'category' => ['required', 'string', 'in:bug,feedback,feature,other'],
            'severity' => ['sometimes', 'nullable', 'string', 'in:low,normal,high,critical'],
            'subject' => ['required', 'string', 'max:180'],
            'message' => ['required', 'string', 'max:5000'],
            'author_name' => ['sometimes', 'nullable', 'string', 'max:120'],
            'venue_id' => ['sometimes', 'nullable', 'integer', 'min:1'],
            'context' => ['sometimes', 'nullable', 'array'],
        ]);

        $context = $validated['context'] ?? null;

        if (is_array($context) && $context !== [] && strlen((string) json_encode($context)) > self::CONTEXT_MAX_BYTES) {
            throw ValidationException::withMessages([
                'context' => ['The attached diagnostics are too large to send — untick the diagnostics option and try again.'],
            ]);
        }

        $reference = (string) Str::uuid();
        $subject = trim((string) $validated['subject']);

        $payload = [
            'client_reference' => $reference,
            'category' => (string) $validated['category'],
            'severity' => $validated['severity'] ?? null,
            'subject' => $subject,
            'message' => (string) $validated['message'],
            'author_name' => isset($validated['author_name']) && trim((string) $validated['author_name']) !== ''
                ? trim((string) $validated['author_name'])
                : null,
            'venue_id' => isset($validated['venue_id']) ? (int) $validated['venue_id'] : null,
            'context' => is_array($context) && $context !== [] ? $context : null,
            'os_version' => (string) config('app.version', ''),
        ];

        // One group per report: each is independent, so a report parked in
        // backoff never holds the next one behind it.
        $this->queue->enqueue('post', self::CLOUD_PATH, $payload, [
            'group' => 'feedback:'.$reference,
            'label' => 'Feedback: '.$subject,
            'idempotency_key' => 'feedback:'.$reference,
        ]);

        return $this->ok(['result' => ['queued' => true, 'client_reference' => $reference]]);
    }

    /**
     * Reports still in the queue (pending or mid-send), newest first. The
     * subject and category come from the job's own payload, so the list
     * reads like the cloud's without a round trip.
     *
     * @return list<array{client_reference: ?string, category: string, subject: string, created_at: string}>
     */
    private function pending(): array
    {
        return DB::table('cloud_call_queue')
            ->where('method', 'post')
            ->where('path', self::CLOUD_PATH)
            ->whereIn('status', ['pending', 'sending'])
            ->orderByDesc('id')
            ->get(['payload', 'created_at'])
            ->map(function (object $job): array {
                $payload = (array) json_decode((string) $job->payload, true);

                return [
                    'client_reference' => isset($payload['client_reference']) ? (string) $payload['client_reference'] : null,
                    'category' => (string) ($payload['category'] ?? 'other'),
                    'subject' => (string) ($payload['subject'] ?? ''),
                    // The queue stores a bare app-timezone (UTC) stamp; the
                    // cloud's rows carry an offset. Sending both as ISO8601
                    // keeps a queued row's time from reading ten hours off
                    // once the UI renders it in the venue's local time.
                    'created_at' => CarbonImmutable::parse((string) $job->created_at, config('app.timezone'))->toIso8601String(),
                ];
            })
            ->values()
            ->all();
    }

    private function ok(array $data): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => $data]);
    }
}
