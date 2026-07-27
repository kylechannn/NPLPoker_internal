<?php

declare(strict_types=1);

namespace App\Services\Cloud;

/**
 * Reads the CD-Key lease the Go host wrote at activation.
 *
 * The Go host owns activation (see license.go); this backend only needs the
 * key and device id to authenticate cloud pulls, so it reads the same
 * license.json rather than keeping a second copy that could drift.
 */
final class LicenseKeyProvider
{
    private ?array $cache = null;

    public function key(): ?string
    {
        return $this->read()['key'] ?? null;
    }

    public function deviceId(): ?string
    {
        return $this->read()['device_id'] ?? null;
    }

    public function lease(): ?array
    {
        return $this->read()['lease'] ?? null;
    }

    public function isActivated(): bool
    {
        return ($this->key() ?? '') !== '' && $this->lease() !== null;
    }

    /** True while the lease the cloud granted is still in force. */
    public function leaseValid(): bool
    {
        $leaseUntil = $this->lease()['lease_until'] ?? null;

        if (! is_string($leaseUntil) || $leaseUntil === '') {
            return false;
        }

        return strtotime($leaseUntil) > time();
    }

    public function path(): string
    {
        $configured = trim((string) env('NPL_INTERNAL_DATA_DIR', ''));

        if ($configured !== '') {
            return rtrim($configured, '/\\').DIRECTORY_SEPARATOR.'license.json';
        }

        $base = getenv('APPDATA') ?: (getenv('HOME') ?: sys_get_temp_dir());

        return rtrim((string) $base, '/\\').DIRECTORY_SEPARATOR.'NPLPokerInternal'.DIRECTORY_SEPARATOR.'license.json';
    }

    public function forget(): void
    {
        $this->cache = null;
    }

    private function read(): array
    {
        if ($this->cache !== null) {
            return $this->cache;
        }

        $path = $this->path();

        if (! is_file($path)) {
            return $this->cache = [];
        }

        $decoded = json_decode((string) file_get_contents($path), true);

        return $this->cache = is_array($decoded) ? $decoded : [];
    }
}
