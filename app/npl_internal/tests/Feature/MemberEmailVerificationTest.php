<?php

namespace Tests\Feature;

use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Sync\DeltaSyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class MemberEmailVerificationTest extends TestCase
{
    use RefreshDatabase;

    private string $licenseDir;

    protected function setUp(): void
    {
        parent::setUp();
        $this->licenseDir = sys_get_temp_dir().'/npl-verification-test-'.uniqid();
        mkdir($this->licenseDir);
        file_put_contents($this->licenseDir.'/license.json', json_encode(['key' => 'TEST-KEY', 'device_id' => 'DESK-1']));
        putenv('NPL_INTERNAL_DATA_DIR='.$this->licenseDir);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $_SERVER['NPL_INTERNAL_DATA_DIR'] = $this->licenseDir;
        app(LicenseKeyProvider::class)->forget();
    }

    protected function tearDown(): void
    {
        putenv('NPL_INTERNAL_DATA_DIR');
        unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
        @unlink($this->licenseDir.'/license.json');
        @rmdir($this->licenseDir);
        parent::tearDown();
    }

    public function test_mark_used_is_authoritative_and_preserves_verification_refusal_without_queueing(): void
    {
        Http::fake(['*' => Http::response(['ok' => false, 'error' => [
            'code' => 'EMAIL_VERIFICATION_REQUIRED', 'message' => 'Verify the member email before using a voucher.',
        ]], 403)]);
        $this->postJson('/api/v1/players/vouchers/9/mark-used', ['npl_id' => 'NEW1', 'reference' => 'DM-VERIFY-1'])
            ->assertForbidden()->assertJsonPath('ok', false)->assertJsonPath('error.code', 'EMAIL_VERIFICATION_REQUIRED');
        $this->assertDatabaseCount('cloud_call_queue', 0);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/vouchers/9/mark-used') && $request['reference'] === 'DM-VERIFY-1');
    }

    public function test_mark_used_only_reports_success_from_the_cloud_and_forwards_same_reference_on_retry(): void
    {
        Http::fake(['*' => Http::response(['ok' => true, 'data' => ['voucher' => ['id' => 9, 'status' => 'used', 'uses_count' => 1]]])]);
        for ($attempt = 0; $attempt < 2; $attempt++) {
            $this->postJson('/api/v1/players/vouchers/9/mark-used', ['npl_id' => 'NEW1', 'reference' => 'DM-VERIFY-1'])
                ->assertOk()->assertJsonPath('data.result.voucher.uses_count', 1);
        }
        $this->assertDatabaseCount('cloud_call_queue', 0);
        Http::assertSentCount(2);
        Http::assertSent(fn ($request) => $request['reference'] === 'DM-VERIFY-1');
    }

    public function test_offline_mark_used_does_not_claim_success_or_enqueue_a_future_redemption(): void
    {
        Http::fake(fn () => throw new ConnectionException('Offline'));
        $this->postJson('/api/v1/players/vouchers/9/mark-used', ['npl_id' => 'NEW1', 'reference' => 'DM-VERIFY-1'])
            ->assertStatus(502)->assertJsonPath('ok', false);
        $this->assertDatabaseCount('cloud_call_queue', 0);
    }

    public function test_signup_without_code_mirrors_pending_player_even_if_verification_mail_failed(): void
    {
        Http::fake(['*' => Http::response(['ok' => true, 'data' => [
            'player' => ['id' => 8, 'npl_id' => 'NEW1', 'display_name' => 'New Member', 'public_player_code' => 'NL0000008',
                'email_verification_required' => true, 'can_use_vouchers' => false],
            'verification_email_sent' => false,
        ]])]);
        $this->postJson('/api/v1/players/register', ['npl_id' => 'NEW1', 'email' => 'new@example.com'])
            ->assertOk()->assertJsonPath('data.result.verification_email_sent', false);
        Http::assertSent(fn ($request) => str_contains($request->url(), '/players/register') && ! isset($request['verification_code']));
        $this->getJson('/api/v1/players?query=NEW1')->assertOk()
            ->assertJsonPath('data.players.0.email_verification_required', true)
            ->assertJsonPath('data.players.0.can_use_vouchers', false);
        $this->assertDatabaseHas('mirror_players', ['npl_id' => 'NEW1', 'status' => 'active']);
    }

    public function test_legacy_players_keep_voucher_access_and_roster_visibility(): void
    {
        DB::table('mirror_players')->insert(['cloud_id' => 7, 'npl_id' => 'OLD1', 'status' => 'active', 'created_at' => now(), 'updated_at' => now()]);
        $this->getJson('/api/v1/players?query=OLD1')->assertOk()
            ->assertJsonPath('data.players.0.email_verification_required', false)
            ->assertJsonPath('data.players.0.can_use_vouchers', true);
    }

    public function test_entitlement_preserves_restriction_and_existing_paid_coverage(): void
    {
        $coverage = ['voucher_id' => 9, 'code' => 'PAID', 'value_cents' => 2500];
        Http::fake(['*' => Http::response(['ok' => true, 'data' => [
            'entitled' => false, 'voucher' => null, 'already_covered' => $coverage,
            'restriction_code' => 'EMAIL_VERIFICATION_REQUIRED', 'email_verification_required' => true,
        ]])]);
        $this->postJson('/api/v1/vouchers/entitlement', ['npl_id' => 'NEW1', 'game_session_id' => 42])
            ->assertOk()->assertJsonPath('data.entitled', false)
            ->assertJsonPath('data.restriction_code', 'EMAIL_VERIFICATION_REQUIRED')
            ->assertJsonPath('data.already_covered.value_cents', 2500);
    }

    public function test_desk_redemption_preserves_verification_refusal(): void
    {
        Http::fake(['*' => Http::response(['ok' => false, 'error' => [
            'code' => 'EMAIL_VERIFICATION_REQUIRED', 'message' => 'Verify the member email before using a voucher.',
        ]], 403)]);
        $this->postJson('/api/v1/vouchers/redeem', ['npl_id' => 'NEW1', 'voucher_id' => 9, 'reference' => 'DM-VERIFY-2'])
            ->assertForbidden()->assertJsonPath('error.code', 'EMAIL_VERIFICATION_REQUIRED');
        $this->assertDatabaseCount('cloud_call_queue', 0);
    }

    public function test_player_sync_removes_pending_status_after_remote_verification(): void
    {
        DB::table('mirror_players')->insert(['cloud_id' => 8, 'npl_id' => 'NEW1', 'status' => 'active',
            'email_verification_required' => true, 'can_use_vouchers' => false, 'created_at' => now(), 'updated_at' => now()]);
        Http::fake(fn ($request) => Http::response(['ok' => true, 'data' => str_contains($request->url(), '/players/ids')
            ? ['ids' => [8]]
            : ['upserts' => [['id' => 8, 'npl_id' => 'NEW1', 'email_verification_required' => false, 'can_use_vouchers' => true]],
                'has_more' => false, 'watermark' => now()->toIso8601String()],
        ]));
        app(DeltaSyncService::class)->sync('players', true);
        $this->getJson('/api/v1/players?query=NEW1')->assertOk()
            ->assertJsonPath('data.players.0.email_verification_required', false)
            ->assertJsonPath('data.players.0.can_use_vouchers', true);
    }
}
