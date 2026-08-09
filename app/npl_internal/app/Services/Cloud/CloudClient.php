<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * The ONE HTTP client for every cloud call.
 *
 * EdgeHost grew four clients (CloudClient, the outbox's own builder, a raw
 * Guzzle pool for avatars, and one in Go), each re-resolving base URL,
 * timeouts and TLS settings — guaranteed config drift. Everything here
 * goes through this class.
 *
 * Also unlike EdgeHost: GETs may retry (they are idempotent), POSTs never
 * retry blindly — they carry an Idempotency-Key so a retry is the caller's
 * explicit, safe decision.
 */
final class CloudClient
{
    public function __construct(private readonly LicenseKeyProvider $license) {}

    /**
     * Conditional GET. Pass the stored ETag to get a cheap 304 instead of
     * re-downloading rows that have not changed — EdgeHost had no
     * conditional requests on data at all and re-pulled everything, every
     * time, for every entity.
     *
     * @return array{status: int, data: array, etag: ?string, not_modified: bool}
     */
    public function getJson(string $path, array $query = [], ?string $etag = null): array
    {
        // Only connection failures are retried; a 4xx/5xx body is returned so
        // assertOk() can classify it into a typed CloudException.
        $request = $this->base()->retry(3, 250, function (?\Throwable $e): bool {
            return $e instanceof ConnectionException;
        }, throw: false);

        if ($etag !== null && $etag !== '') {
            $request = $request->withHeaders(['If-None-Match' => $etag]);
        }

        try {
            $response = $request->get($this->url($path), $query);
        } catch (ConnectionException $e) {
            throw new CloudException(CloudException::UNREACHABLE, 'Could not reach the NPL cloud: '.$e->getMessage(), null, $e);
        }

        if ($response->status() === 304) {
            return ['status' => 304, 'data' => [], 'etag' => $etag, 'not_modified' => true];
        }

        $this->assertOk($response, $path);

        $body = $response->json();
        if (! is_array($body) || ($body['ok'] ?? null) !== true) {
            throw new CloudException(
                CloudException::BAD_RESPONSE,
                sprintf('Unexpected payload from %s (status %d).', $path, $response->status()),
                $response->status(),
            );
        }

        return [
            'status' => $response->status(),
            'data' => (array) ($body['data'] ?? []),
            'etag' => $response->header('ETag') ?: null,
            'not_modified' => false,
        ];
    }

    /** Writes carry an idempotency key and are never retried behind your back. */
    public function postJson(string $path, array $payload, ?string $idempotencyKey = null): array
    {
        $request = $this->base()->withHeaders([
            'Idempotency-Key' => $idempotencyKey ?: (string) Str::uuid(),
        ]);

        try {
            $response = $request->post($this->url($path), $payload);
        } catch (ConnectionException $e) {
            throw new CloudException(CloudException::UNREACHABLE, 'Could not reach the NPL cloud: '.$e->getMessage(), null, $e);
        }

        $this->assertOk($response, $path);

        $body = $response->json();

        return is_array($body) ? (array) ($body['data'] ?? []) : [];
    }

    public function deleteJson(string $path): array
    {
        try {
            $response = $this->base()->delete($this->url($path));
        } catch (ConnectionException $e) {
            throw new CloudException(CloudException::UNREACHABLE, 'Could not reach the NPL cloud: '.$e->getMessage(), null, $e);
        }

        $this->assertOk($response, $path);

        $body = $response->json();

        return is_array($body) ? (array) ($body['data'] ?? []) : [];
    }

    /**
     * Stream a media file to disk with conditional headers. Returns null
     * when the cloud answers 304, so unchanged images are never re-fetched
     * (EdgeHost's ad mirror had no conditional support: either "file exists,
     * skip forever" or "force, re-download everything").
     *
     * @return array{path: string, mime: ?string, bytes: int, etag: ?string, last_modified: ?string}|null
     */
    public function downloadMedia(string $url, string $destination, ?string $etag = null, ?string $lastModified = null): ?array
    {
        $headers = [];
        if ($etag) {
            $headers['If-None-Match'] = $etag;
        }
        if ($lastModified) {
            $headers['If-Modified-Since'] = $lastModified;
        }

        try {
            $response = Http::withHeaders($headers)
                ->withOptions(['verify' => $this->verify()])
                ->timeout((int) config('nplcloud.timeouts.media', 60))
                ->connectTimeout((int) config('nplcloud.timeouts.connect', 10))
                ->get($this->absolute($url));
        } catch (ConnectionException $e) {
            throw new CloudException(CloudException::UNREACHABLE, 'Media download failed: '.$e->getMessage(), null, $e);
        }

        if ($response->status() === 304) {
            return null;
        }

        if (! $response->successful()) {
            throw new CloudException(
                $response->status() >= 500 ? CloudException::SERVER_ERROR : CloudException::BAD_RESPONSE,
                sprintf('Media download failed (%d) for %s', $response->status(), $url),
                $response->status(),
            );
        }

        $body = $response->body();
        $max = (int) config('nplcloud.media.max_bytes', 8 * 1024 * 1024);

        if (strlen($body) > $max) {
            throw new CloudException(CloudException::BAD_RESPONSE, sprintf('Media at %s exceeds the %d byte cap.', $url, $max));
        }

        // Write to a temp file then rename — a crash mid-write can never
        // leave a truncated image that later counts as "cached".
        $directory = dirname($destination);
        if (! is_dir($directory)) {
            mkdir($directory, 0o755, true);
        }
        $temp = $destination.'.part';
        if (file_put_contents($temp, $body) === false) {
            throw new CloudException(CloudException::BAD_RESPONSE, 'Could not write media to '.$temp);
        }
        if (! @rename($temp, $destination)) {
            @unlink($temp);
            throw new CloudException(CloudException::BAD_RESPONSE, 'Could not finalise media at '.$destination);
        }

        return [
            'path' => $destination,
            'mime' => $response->header('Content-Type') ?: null,
            'bytes' => strlen($body),
            'etag' => $response->header('ETag') ?: null,
            'last_modified' => $response->header('Last-Modified') ?: null,
        ];
    }

    private function base(): PendingRequest
    {
        return Http::withHeaders(array_filter([
            'Accept' => 'application/json',
            'X-CD-Key' => $this->license->key(),
            'X-Device-Id' => $this->license->deviceId(),
            // The cloud's EnsureInternalOsVersion gate reads this header to
            // decide whether the desk is current enough to keep operating.
            'X-App-Version' => (string) config('app.version', ''),
        ]))
            ->withOptions(['verify' => $this->verify()])
            ->timeout((int) config('nplcloud.timeouts.request', 30))
            ->connectTimeout((int) config('nplcloud.timeouts.connect', 10));
    }

    /**
     * Guzzle's `verify` option: false when verification is disabled, a path
     * to our bundled Mozilla roots when they exist (the portable php.exe has
     * no system CA store — without this every venue machine fails with cURL
     * error 60), or true to fall back to whatever curl can find.
     */
    private function verify(): bool|string
    {
        if (! config('nplcloud.verify_ssl', true)) {
            return false;
        }

        $bundle = (string) (config('nplcloud.ca_bundle') ?: base_path('resources/certs/cacert.pem'));

        return is_file($bundle) ? $bundle : true;
    }

    private function assertOk(Response $response, string $path): void
    {
        if ($response->successful()) {
            return;
        }

        $status = $response->status();

        $code = match (true) {
            $status === 401 || $status === 403 => CloudException::UNAUTHORISED,
            // 426 Upgrade Required: this build is below the cloud's minimum
            // and every internal endpoint will refuse until it is updated.
            $status === 426 => CloudException::UPDATE_REQUIRED,
            $status === 429 => CloudException::RATE_LIMITED,
            $status >= 500 => CloudException::SERVER_ERROR,
            default => CloudException::BAD_RESPONSE,
        };

        // The first field error is the sentence the operator needs ("That
        // code doesn't match…"), not the generic envelope message.
        $json = (array) $response->json();
        $fieldErrors = is_array($json['errors'] ?? null) ? array_values($json['errors']) : [];
        $message = (string) (($json['error']['message'] ?? null)
            ?: ($fieldErrors[0][0] ?? null)
            ?: ($json['message'] ?? null)
            ?: $response->body());

        throw new CloudException($code, sprintf('%s failed (%d): %s', $path, $status, Str::limit($message, 300)), $status);
    }

    private function url(string $path): string
    {
        return $this->absolute($path);
    }

    private function absolute(string $pathOrUrl): string
    {
        if (Str::startsWith($pathOrUrl, ['http://', 'https://'])) {
            return $pathOrUrl;
        }

        return rtrim((string) config('nplcloud.base'), '/').'/'.ltrim($pathOrUrl, '/');
    }
}
