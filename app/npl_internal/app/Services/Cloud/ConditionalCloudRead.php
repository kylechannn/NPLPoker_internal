<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use App\Support\MirrorTableTimer;
use Illuminate\Support\Facades\Cache;

/** A cached HTTP representation, never proof that a local command was applied. */
final class ConditionalCloudRead
{
    public function __construct(private readonly CloudClient $cloud, private readonly LicenseKeyProvider $license) {}

    /** @return array{data: array, not_modified: bool, received_at_ms: int} */
    public function get(string $path, array $query = []): array
    {
        $identity = $this->license->identity();
        $key = 'cloud-read:'.hash('sha256', json_encode([
            $identity, config('nplcloud.base'), $path, $query, app()->getLocale(),
        ], JSON_THROW_ON_ERROR));
        $cached = Cache::get($key);
        $hasBody = is_array($cached) && is_array($cached['data'] ?? null)
            && is_numeric($cached['received_at_ms'] ?? null);
        $result = $this->cloud->getJson($path, $query, $hasBody ? ($cached['etag'] ?? null) : null, true);
        if ($result['not_modified'] && ! $hasBody) {
            // A validator without its representation cannot stand in for data.
            $result = $this->cloud->getJson($path, $query);
            if ($result['not_modified']) {
                throw new CloudException(CloudException::BAD_RESPONSE, 'A conditional cloud response has no cached representation.');
            }
        }
        if ($this->license->identity() !== $identity) {
            throw new CloudException(CloudException::BAD_RESPONSE, 'The desk licence changed during the cloud read. Retry from the current desk.');
        }
        if ($result['not_modified']) {
            return ['data' => $cached['data'], 'not_modified' => true, 'received_at_ms' => (int) $cached['received_at_ms']];
        }
        $snapshot = ['data' => $result['data'], 'etag' => $result['etag'], 'received_at_ms' => MirrorTableTimer::nowMs()];
        // The complete body is replayed after 304, even if a previous local apply
        // failed. Never cache an "already applied" marker or a failed response.
        Cache::put($key, $snapshot, now()->addHour());

        return ['data' => $snapshot['data'], 'not_modified' => false, 'received_at_ms' => $snapshot['received_at_ms']];
    }
}
