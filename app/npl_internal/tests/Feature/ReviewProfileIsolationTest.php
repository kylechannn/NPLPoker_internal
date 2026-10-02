<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Cloud\LicenseKeyProvider;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

final class ReviewProfileIsolationTest extends TestCase
{
    public function test_only_matching_profiles_accept_a_lease(): void
    {
        foreach ([false, true] as $profile) {
            foreach ([false, true] as $license) {
                $this->withLease($license, function () use ($profile, $license): void {
                    config(['nplcloud.review_profile' => $profile]);
                    $provider = app(LicenseKeyProvider::class);
                    $this->assertSame($profile === $license, $provider->isActivated());
                    $this->assertSame($profile === $license, $provider->leaseValid());
                });
            }
        }
    }

    public function test_cross_profile_cloud_write_is_refused_before_http(): void
    {
        $this->withLease(false, function (): void {
            config(['nplcloud.review_profile' => true]);
            Http::fake();
            try {
                app(CloudClient::class)->postJson('/api/v1/internal/tournaments/broadcast', ['test' => true]);
                $this->fail('A venue licence was sent by the review profile.');
            } catch (CloudException $error) {
                $this->assertSame(CloudException::UNAUTHORISED, $error->errorCode);
            }
            Http::assertNothingSent();
        });
    }

    private function withLease(bool $review, callable $run): void
    {
        $directory = sys_get_temp_dir().'/npl-review-isolation-'.bin2hex(random_bytes(8));
        mkdir($directory, 0700, true);
        file_put_contents($directory.'/license.json', json_encode([
            'key' => 'TEST-KEY', 'device_id' => 'TEST-DEVICE',
            'lease' => ['is_app_review' => $review, 'lease_until' => now()->addHour()->toIso8601String()],
        ]));
        $previous = getenv('NPL_INTERNAL_DATA_DIR');
        putenv('NPL_INTERNAL_DATA_DIR='.$directory);
        $_ENV['NPL_INTERNAL_DATA_DIR'] = $directory;
        $_SERVER['NPL_INTERNAL_DATA_DIR'] = $directory;
        app(LicenseKeyProvider::class)->forget();
        try {
            $run();
        } finally {
            if ($previous === false) {
                putenv('NPL_INTERNAL_DATA_DIR');
                unset($_ENV['NPL_INTERNAL_DATA_DIR'], $_SERVER['NPL_INTERNAL_DATA_DIR']);
            } else {
                putenv('NPL_INTERNAL_DATA_DIR='.$previous);
                $_ENV['NPL_INTERNAL_DATA_DIR'] = $previous;
                $_SERVER['NPL_INTERNAL_DATA_DIR'] = $previous;
            }
            app(LicenseKeyProvider::class)->forget();
            unlink($directory.'/license.json');
            rmdir($directory);
        }
    }
}
