<?php

namespace Tests\Feature;

use App\Services\Cloud\CloudCallQueue;
use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\LicenseKeyProvider;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * Feedback & Reports: a report typed at the desk rides the cloud call
 * queue (offline-safe, reference-idempotent), and the feed reads live from
 * the cloud with this desk's still-queued reports listed alongside.
 */
class FeedbackTest extends TestCase
{
    use RefreshDatabase;

    private ?string $licenseDir = null;

    private function activateLicense(): void
    {
        $dir = sys_get_temp_dir().'/npl-feedback-test-'.uniqid();
        mkdir($dir, 0o755, true);
        file_put_contents($dir.'/license.json', json_encode([
            'key' => 'NPL-TEST',
            'device_id' => 'device-test',
            'lease' => ['lease_until' => '2030-01-01T00:00:00+00:00'],
        ]));
        putenv('NPL_INTERNAL_DATA_DIR='.$dir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $dir;
        $_SERVER['NPL_INTERNAL_DATA_DIR'] = $dir;
        app(LicenseKeyProvider::class)->forget();
        $this->licenseDir = $dir;
    }

    private function sampleReport(): array
    {
        return [
            'id' => 41,
            'client_reference' => '0d3f6d0e-2c3a-4d55-9b1e-3f1a2b3c4d5e',
            'category' => 'bug',
            'severity' => 'high',
            'subject' => 'Clock froze at level 4',
            'message' => 'The room clock stopped counting down after the break.',
            'author_name' => 'Kyle Chan',
            'venue_id' => 7,
            'venue_name' => 'St George Club',
            'os_version' => '1.4.0',
            'status' => 'acknowledged',
            'admin_notes' => 'Thanks — fixed in the next build.',
            'created_at' => '2026-08-20T09:12:00+10:00',
            'handled_at' => '2026-08-21T10:00:00+10:00',
        ];
    }

    public function test_offline_report_queues_one_cloud_call_and_answers_queued(): void
    {
        $this->activateLicense();
        config(['app.version' => '1.4.2']);
        app(CloudLinkState::class)->markOffline();
        Http::fake();

        $response = $this->postJson('/api/v1/feedback', [
            'category' => 'bug',
            'severity' => 'high',
            'subject' => 'Clock froze at level 4',
            'message' => 'The room clock stopped counting down after the break.',
            'author_name' => 'Kyle Chan',
            'venue_id' => 7,
            'context' => ['section' => 'tournament', 'network' => ['grade' => 'Good']],
        ]);

        $response->assertOk();
        $this->assertTrue($response->json('data.result.queued'));
        $reference = $response->json('data.result.client_reference');
        $this->assertIsString($reference);
        $this->assertMatchesRegularExpression('/^[0-9a-f-]{36}$/', $reference);
        Http::assertNothingSent();

        $jobs = DB::table('cloud_call_queue')->where('path', '/api/v1/internal/feedback')->get();
        $this->assertCount(1, $jobs, 'one report is exactly one queued cloud call');

        $job = $jobs[0];
        $this->assertSame('post', $job->method);
        $this->assertSame('pending', $job->status);
        $this->assertSame('feedback:'.$reference, $job->group_key);
        $this->assertSame('Feedback: Clock froze at level 4', $job->label);

        $payload = json_decode((string) $job->payload, true);
        $this->assertSame($reference, $payload['client_reference']);
        $this->assertSame('1.4.2', $payload['os_version'], 'the OS build is stamped from config so head office knows the version');
        $this->assertSame('Clock froze at level 4', $payload['subject']);
        $this->assertSame('bug', $payload['category']);
        $this->assertSame('high', $payload['severity']);
        $this->assertSame(7, $payload['venue_id']);
        $this->assertSame('tournament', $payload['context']['section']);
    }

    public function test_online_report_lands_on_the_cloud_with_its_reference_build_and_idempotency_key(): void
    {
        $this->activateLicense();
        config(['app.version' => '1.4.2']);
        Http::fake([
            '*/api/v1/internal/feedback*' => Http::response([
                'ok' => true,
                'message' => 'Feedback received.',
                'data' => ['report' => $this->sampleReport()],
            ], 201),
        ]);

        $response = $this->postJson('/api/v1/feedback', [
            'category' => 'bug',
            'severity' => 'high',
            'subject' => 'Clock froze at level 4',
            'message' => 'The room clock stopped counting down after the break.',
            'author_name' => 'Kyle Chan',
            'venue_id' => 7,
            'context' => ['network' => ['grade' => 'Good'], 'screen' => '1920x1080'],
        ]);

        $response->assertOk();
        $reference = $response->json('data.result.client_reference');

        // Console runs (tests included) drain inline on enqueue, so with
        // the link green the report has landed by the time the desk gets
        // its answer — the queue row is the receipt.
        $job = DB::table('cloud_call_queue')->where('path', '/api/v1/internal/feedback')->first();
        $this->assertNotNull($job);
        $this->assertSame('sent', $job->status);
        $this->assertSame(1, (int) $job->attempts);

        // What the cloud actually received: the OS half of the contract.
        // The reference and the build travel in the body, the build again
        // in X-App-Version (the header wins on the cloud), and the
        // Idempotency-Key is derived from the reference so a replay of
        // this exact job is recognisable before the body is even parsed.
        Http::assertSentCount(1);
        Http::assertSent(fn (ClientRequest $request): bool => $request->method() === 'POST'
            && str_ends_with($request->url(), '/api/v1/internal/feedback')
            && $request->hasHeader('Idempotency-Key', 'feedback:'.$reference)
            && $request->hasHeader('X-App-Version', '1.4.2')
            && $request['client_reference'] === $reference
            && $request['os_version'] === '1.4.2'
            && $request['category'] === 'bug'
            && $request['severity'] === 'high'
            && $request['subject'] === 'Clock froze at level 4'
            && $request['message'] === 'The room clock stopped counting down after the break.'
            && $request['author_name'] === 'Kyle Chan'
            && $request['venue_id'] === 7
            && $request['context'] === ['network' => ['grade' => 'Good'], 'screen' => '1920x1080']);
    }

    public function test_a_retry_after_a_lost_reply_replays_the_same_reference_and_the_cloud_200_counts_as_sent(): void
    {
        $this->activateLicense();
        config(['app.version' => '1.4.2']);

        // The first dial reaches the cloud but the reply is lost mid-flight
        // — the classic double-submit hazard. Every dial after that
        // succeeds: the /up recovery probe, then the retried POST, which
        // the cloud answers with 200 and the row it already stored rather
        // than 201 for a twin. Each feedback dial is recorded from inside
        // the fake because a dial that throws is never in Http's log.
        $dials = [];
        Http::fake(function (ClientRequest $request) use (&$dials) {
            if (str_ends_with($request->url(), '/up')) {
                return Http::response('', 200);
            }

            $dials[] = [$request['client_reference'], $request->header('Idempotency-Key')[0] ?? null];

            if (count($dials) === 1) {
                throw new ConnectionException('cURL error 56: reply lost');
            }

            return Http::response([
                'ok' => true,
                'message' => 'Feedback already received.',
                'data' => ['report' => $this->sampleReport()],
            ], 200);
        });

        $reference = $this->postJson('/api/v1/feedback', [
            'category' => 'feedback',
            'subject' => 'Seat draw feels slow',
            'message' => 'It takes a few seconds before the table shows.',
        ])->assertOk()->json('data.result.client_reference');

        // The inline drain dialed once and lost the reply: the job keeps
        // its place with its attempt budget untouched, and the link is
        // marked down so nothing dials again until the probe is due.
        $job = DB::table('cloud_call_queue')->where('path', '/api/v1/internal/feedback')->first();
        $this->assertNotNull($job);
        $this->assertSame('pending', $job->status);
        $this->assertSame(0, (int) $job->attempts, 'a lost link must never burn retry budget');
        $this->assertTrue(app(CloudLinkState::class)->isOffline());

        // The next sweep after the probe interval: /up answers, the link
        // is back, and the very same job goes again.
        $this->travel(20)->seconds();
        $result = app(CloudCallQueue::class)->drain();

        $this->assertSame(1, $result['sent']);
        $this->assertFalse(app(CloudLinkState::class)->isOffline());

        $job = DB::table('cloud_call_queue')->where('id', $job->id)->first();
        $this->assertSame('sent', $job->status, 'the cloud\'s 200 replay is delivery, not a failure to retry');
        $this->assertSame(1, (int) $job->attempts);
        $this->assertSame(0, DB::table('cloud_call_queue')->where('path', '/api/v1/internal/feedback')->where('status', '!=', 'sent')->count());

        // Both dials carried the same reference and the same
        // Idempotency-Key — that is what lets the cloud file one report.
        $this->assertSame([
            [$reference, 'feedback:'.$reference],
            [$reference, 'feedback:'.$reference],
        ], $dials);
    }

    public function test_validation_refuses_a_missing_subject_and_an_unknown_category(): void
    {
        Http::fake();

        $this->postJson('/api/v1/feedback', [
            'category' => 'bug',
            'message' => 'Something broke.',
        ])->assertStatus(422)->assertJsonValidationErrors(['subject']);

        $this->postJson('/api/v1/feedback', [
            'category' => 'complaint',
            'subject' => 'Hello',
            'message' => 'Something broke.',
        ])->assertStatus(422)->assertJsonValidationErrors(['category']);

        // Format failures refuse HERE — nothing may reach the queue.
        $this->assertSame(0, DB::table('cloud_call_queue')->count());
        Http::assertNothingSent();
    }

    public function test_feed_passes_cloud_reports_through_and_lists_the_queued_row(): void
    {
        $this->activateLicense();
        app(CloudLinkState::class)->markOffline();
        // One fake for the whole test: stubs match in registration order,
        // so a bare Http::fake() first would answer every call with an
        // empty 200 and this pattern would never be reached.
        Http::fake([
            '*/api/v1/internal/feedback*' => Http::response([
                'ok' => true,
                'data' => ['reports' => [$this->sampleReport()], 'truncated' => false],
            ]),
        ]);

        // Queue one offline first, so the feed has something of its own.
        $queued = $this->postJson('/api/v1/feedback', [
            'category' => 'feature',
            'subject' => 'Bigger seat numbers on the clock',
            'message' => 'Players at the back cannot read them.',
        ]);
        $queued->assertOk();
        $reference = $queued->json('data.result.client_reference');
        Http::assertNothingSent();

        // Now the link is back and the cloud answers with a report list.
        Cache::flush();

        $feed = $this->getJson('/api/v1/feedback');

        $feed->assertOk()
            ->assertJsonPath('data.available', true)
            ->assertJsonPath('data.reports.0.id', 41)
            ->assertJsonPath('data.reports.0.status', 'acknowledged')
            ->assertJsonPath('data.reports.0.admin_notes', 'Thanks — fixed in the next build.')
            ->assertJsonPath('data.pending.0.client_reference', $reference)
            ->assertJsonPath('data.pending.0.category', 'feature')
            ->assertJsonPath('data.pending.0.subject', 'Bigger seat numbers on the clock');

        $this->assertCount(1, $feed->json('data.reports'));
        $this->assertCount(1, $feed->json('data.pending'));
        // Queued rows stamp ISO8601 with an offset, exactly like the cloud's
        // rows, so the UI renders both in the venue's local time.
        $this->assertMatchesRegularExpression(
            '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/',
            $feed->json('data.pending.0.created_at'),
        );

        // Exactly one dial — the licensed feed, capped at 50 per contract;
        // reading the feed never drains the queue behind the operator.
        Http::assertSentCount(1);
        Http::assertSent(fn (ClientRequest $request): bool => $request->method() === 'GET'
            && str_contains($request->url(), '/api/v1/internal/feedback')
            && str_contains($request->url(), 'limit=50'));
    }

    public function test_feed_without_the_cloud_is_unavailable_but_still_lists_the_queue(): void
    {
        $this->activateLicense();
        app(CloudLinkState::class)->markOffline();

        // First no internet at all (the dial itself fails), then a cloud
        // that answers but is broken — both must read as "unavailable".
        $mode = 'unreachable';
        Http::fake(function () use (&$mode) {
            if ($mode === 'unreachable') {
                throw new ConnectionException('cURL error 6');
            }

            return Http::response(['ok' => false, 'error' => ['message' => 'down']], 503);
        });

        $this->postJson('/api/v1/feedback', [
            'category' => 'other',
            'subject' => 'Printer keeps double-printing',
            'message' => 'Every receipt comes out twice since Tuesday.',
        ])->assertOk();
        Http::assertNothingSent();

        Cache::flush();

        $this->getJson('/api/v1/feedback')
            ->assertOk()
            ->assertJsonPath('data.available', false)
            ->assertJsonPath('data.reports', [])
            ->assertJsonPath('data.pending.0.category', 'other')
            ->assertJsonPath('data.pending.0.subject', 'Printer keeps double-printing');

        // The failed dial marked the link offline — the queued row stays.
        $this->assertTrue(app(CloudLinkState::class)->isOffline());

        Cache::flush();
        $mode = 'server_error';

        $this->getJson('/api/v1/feedback')
            ->assertOk()
            ->assertJsonPath('data.available', false)
            ->assertJsonPath('data.reports', [])
            ->assertJsonPath('data.pending.0.subject', 'Printer keeps double-printing');

        $this->assertSame(1, DB::table('cloud_call_queue')->where('path', '/api/v1/internal/feedback')->where('status', 'pending')->count());
    }

    protected function tearDown(): void
    {
        if ($this->licenseDir !== null) {
            putenv('NPL_INTERNAL_DATA_DIR');
            unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
            @unlink($this->licenseDir.'/license.json');
            @rmdir($this->licenseDir);
            $this->licenseDir = null;
        }
        Cache::flush();

        parent::tearDown();
    }
}
