<?php

namespace Tests\Feature;

use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Tournament\TournamentBroadcaster;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class WheelApprovalProxyTest extends TestCase
{
    use RefreshDatabase;

    private string $licenseDir;

    protected function setUp(): void
    {
        parent::setUp();
        $this->licenseDir = sys_get_temp_dir().'/npl-wheel-test-'.uniqid();
        mkdir($this->licenseDir);
        file_put_contents($this->licenseDir.'/license.json', json_encode(['key' => 'TEST-KEY', 'device_id' => 'DESK-1']));
        putenv('NPL_INTERNAL_DATA_DIR='.$this->licenseDir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $_SERVER['NPL_INTERNAL_DATA_DIR'] = $this->licenseDir;
        app(LicenseKeyProvider::class)->forget();
        DB::table('mirror_players')->insert(['cloud_id' => 1, 'npl_id' => 'VERIFY1', 'display_name' => 'Test Player', 'status' => 'active', 'created_at' => now(), 'updated_at' => now()]);
    }

    protected function tearDown(): void
    {
        putenv('NPL_INTERNAL_DATA_DIR');
        unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
        @unlink($this->licenseDir.'/license.json');
        @rmdir($this->licenseDir);
        parent::tearDown();
    }

    public function test_wheel_requires_operator_identity_before_any_cloud_call(): void
    {
        Http::fake();
        $this->postJson('/api/v1/wheel/lookup', ['npl_id' => 'VERIFY1'])->assertUnauthorized();
        $this->postJson('/api/v1/wheel/spin', ['reference' => 'TEST-SPIN', 'npl_id' => 'VERIFY1'])->assertUnauthorized();
        $this->getJson('/api/v1/wheel/approvals/9')->assertUnauthorized();
        Http::assertNothingSent();
    }

    public function test_preflight_uses_query_and_operator_token_and_never_opens_wheel_offline(): void
    {
        Http::fake(['*' => Http::response(['ok' => true, 'data' => ['eligible' => true, 'approval_required' => true]])]);
        $this->withToken('operator-jwt')->postJson('/api/v1/wheel/lookup', ['npl_id' => 'VERIFY1'])->assertOk()->assertJsonPath('data.eligibility.approval_required', true);
        Http::assertSent(fn ($r) => str_contains($r->url(), 'wheel/eligibility?npl_id=VERIFY1') && $r->hasHeader('Authorization', 'Bearer operator-jwt') && $r->hasHeader('X-CD-Key', 'TEST-KEY') && $r->hasHeader('X-Device-Id', 'DESK-1'));
        Http::fake(fn () => throw new ConnectionException('Offline'));
        $this->postJson('/api/v1/wheel/lookup', ['npl_id' => 'VERIFY1'])->assertStatus(502)->assertJsonPath('ok', false);
    }

    public function test_bound_session_draft_and_approval_reference_are_forwarded_with_both_credentials(): void
    {
        Http::fake(['*' => Http::response(['ok' => true, 'data' => ['id' => 9, 'status' => 'awaiting_photo']])]);
        $id = DB::table('tournament_sessions')->insertGetId(['uuid' => '12345678-test-session', 'name' => 'Bound wheel session', 'status' => 'draft', 'created_at' => now(), 'updated_at' => now()]);
        $uid = app(TournamentBroadcaster::class)->uid($id);
        $this->withToken('operator-jwt')->postJson('/api/v1/wheel/approvals', [
            'reference' => 'PHOTO-REQUEST', 'npl_id' => 'VERIFY1', 'wheel' => 'normal', 'tournament_uid' => $uid,
        ])->assertOk()->assertJsonPath('data.id', 9)->assertJsonPath('data.status', 'awaiting_photo');
        Http::assertSent(fn ($r) => str_contains($r->url(), '/wheel/approvals') && $r->isJson() && $r->hasHeader('Authorization', 'Bearer operator-jwt') && $r->hasHeader('X-CD-Key', 'TEST-KEY') && $r['reference'] === 'PHOTO-REQUEST' && $r['tournament_uid'] === $uid && ! $r->hasFile('photo'));
        Http::fake(['*/internal/wheel/spins' => Http::response(['ok' => true, 'data' => ['duplicate' => false, 'reference' => 'PHOTO-REQUEST']])]);
        $payload = ['reference' => 'PHOTO-REQUEST', 'npl_id' => 'VERIFY1', 'approval_request_id' => 9, 'game_session_id' => 42];
        $this->postJson('/api/v1/wheel/spin', $payload)->assertOk();
        Http::assertSent(fn ($r) => $r->isJson() && $r['reference'] === 'PHOTO-REQUEST' && $r['approval_request_id'] === 9 && $r['game_session_id'] === 42 && $r->hasHeader('Authorization', 'Bearer operator-jwt'));
    }

    public function test_photo_request_requires_the_current_session_and_rejects_os_photos(): void
    {
        Http::fake();
        $payload = ['reference' => 'PHOTO-REQUEST', 'npl_id' => 'VERIFY1', 'wheel' => 'normal', 'tournament_uid' => 'npl:DESK-1:12345678'];
        $this->withToken('operator-jwt')->postJson('/api/v1/wheel/approvals', $payload)->assertUnprocessable();
        DB::table('tournament_sessions')->insert(['uuid' => '99999999-test-session', 'name' => 'Other session', 'status' => 'draft', 'created_at' => now(), 'updated_at' => now()]);
        $this->postJson('/api/v1/wheel/approvals', $payload)->assertConflict();
        $this->post('/api/v1/wheel/approvals', $payload + ['photo' => UploadedFile::fake()->image('hand.jpg')], ['Accept' => 'application/json'])->assertUnprocessable();
        Http::assertNothingSent();
    }

    public function test_cloud_expiry_and_auth_errors_are_preserved_for_the_ui(): void
    {
        $sequence = Http::fakeSequence();
        foreach ([401, 403, 409, 422] as $status) {
            $sequence->push(['ok' => false, 'error' => ['message' => 'Approval expired.']], $status);
        }
        foreach ([401, 403, 409, 422] as $status) {
            $this->withToken('operator-jwt')->postJson('/api/v1/wheel/spin', ['reference' => 'PHOTO-REQUEST', 'npl_id' => 'VERIFY1', 'approval_request_id' => 9])
                ->assertStatus($status)->assertJsonPath('ok', false);
        }
    }
}
