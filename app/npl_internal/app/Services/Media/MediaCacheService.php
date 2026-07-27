<?php

declare(strict_types=1);

namespace App\Services\Media;

use App\Services\Cloud\CloudClient;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Local image cache — the "sync image" side of a manual update.
 *
 * Files are content-addressed (`<hash>.<ext>`) and written atomically, so a
 * changed image lands beside the old one instead of overwriting it in place;
 * a `media_cache` row is the local shortcut the UI resolves through, and
 * `/media/{key}` serves it without touching the cloud again.
 *
 * Improvements over EdgeHost's ad mirror, which had none of this: it did
 * `is_file() && !force` (so a changed image was NEVER re-fetched) and wrote
 * with a suppressed `@file_put_contents` (so a crash left a truncated file
 * that then counted as cached forever). Conditional ETag requests here mean
 * unchanged images cost one 304, and changed ones actually update.
 */
final class MediaCacheService
{
    public function __construct(private readonly CloudClient $cloud) {}

    /** Stable key for a source URL, used as the local filename stem. */
    public function keyFor(string $sourceUrl): string
    {
        return substr(hash('sha256', trim($sourceUrl)), 0, 32);
    }

    public function rootPath(): string
    {
        $configured = trim((string) config('nplcloud.media.disk_path', ''));

        if ($configured !== '') {
            return rtrim($configured, '/\\');
        }

        return storage_path('app/media');
    }

    /**
     * Cache every distinct image referenced by the mirrored tables.
     *
     * @return array{downloaded: int, skipped: int, failed: int, pruned: int}
     */
    public function syncAll(bool $force = false): array
    {
        $sources = $this->collectSources();
        $downloaded = 0;
        $skipped = 0;
        $failed = 0;

        foreach ($sources as $key => $url) {
            try {
                $result = $this->cacheOne($key, $url, $force);
                $result ? $downloaded++ : $skipped++;
            } catch (Throwable $e) {
                $failed++;
                DB::table('media_cache')->updateOrInsert(
                    ['media_key' => $key],
                    [
                        'source_url' => $url,
                        'status' => 'error',
                        'last_error' => Str::limit($e->getMessage(), 500),
                        'last_checked_at' => now(),
                        'updated_at' => now(),
                        'created_at' => now(),
                    ],
                );
                Log::warning('media cache failed', ['key' => $key, 'url' => $url, 'error' => $e->getMessage()]);
            }
        }

        return [
            'downloaded' => $downloaded,
            'skipped' => $skipped,
            'failed' => $failed,
            'pruned' => $this->pruneOrphans(array_keys($sources)),
        ];
    }

    /** @return bool true when bytes were fetched, false when already fresh */
    public function cacheOne(string $key, string $sourceUrl, bool $force = false): bool
    {
        $existing = DB::table('media_cache')->where('media_key', $key)->first();

        if (! $force && $existing && $existing->status === 'ok' && $existing->local_path
            && is_file($this->rootPath().DIRECTORY_SEPARATOR.$existing->local_path)) {
            // Still ask the cloud, but conditionally — a 304 is cheap and a
            // changed image is actually picked up.
            $result = $this->cloud->downloadMedia(
                $sourceUrl,
                $this->tempPath($key),
                $existing->source_etag,
                $existing->source_last_modified,
            );

            if ($result === null) {
                DB::table('media_cache')->where('media_key', $key)->update([
                    'last_checked_at' => now(),
                    'updated_at' => now(),
                ]);

                return false;
            }

            return $this->promote($key, $sourceUrl, $result);
        }

        $result = $this->cloud->downloadMedia($sourceUrl, $this->tempPath($key));

        if ($result === null) {
            return false;
        }

        return $this->promote($key, $sourceUrl, $result);
    }

    /** Move a freshly downloaded temp file to its content-addressed home. */
    private function promote(string $key, string $sourceUrl, array $result): bool
    {
        $temp = $result['path'];
        $hash = hash_file('sha256', $temp) ?: $key;
        $extension = $this->extensionFor($result['mime'] ?? null, $sourceUrl);
        $relative = sprintf('%s/%s.%s', substr($hash, 0, 2), substr($hash, 0, 32), $extension);
        $absolute = $this->rootPath().DIRECTORY_SEPARATOR.$relative;

        $directory = dirname($absolute);
        if (! is_dir($directory)) {
            mkdir($directory, 0o755, true);
        }

        if (! @rename($temp, $absolute)) {
            @copy($temp, $absolute);
            @unlink($temp);
        }

        DB::table('media_cache')->updateOrInsert(
            ['media_key' => $key],
            [
                'source_url' => $sourceUrl,
                'content_hash' => $hash,
                'local_path' => $relative,
                'mime' => $result['mime'],
                'bytes' => $result['bytes'],
                'source_etag' => $result['etag'],
                'source_last_modified' => $result['last_modified'],
                'status' => 'ok',
                'last_error' => null,
                'last_checked_at' => now(),
                'synced_at' => now(),
                'updated_at' => now(),
                'created_at' => now(),
            ],
        );

        return true;
    }

    /**
     * Delete cached files no mirrored row references any more. EdgeHost never
     * swept its ad media, so orphaned images accumulated forever.
     */
    public function pruneOrphans(array $liveKeys): int
    {
        $stale = DB::table('media_cache')
            ->when($liveKeys !== [], fn ($query) => $query->whereNotIn('media_key', $liveKeys))
            ->get();

        $pruned = 0;

        foreach ($stale as $row) {
            if ($row->local_path) {
                $path = $this->rootPath().DIRECTORY_SEPARATOR.$row->local_path;
                if (is_file($path)) {
                    @unlink($path);
                }
            }
            DB::table('media_cache')->where('media_key', $row->media_key)->delete();
            $pruned++;
        }

        return $pruned;
    }

    /** @return array<string, string> media_key => source URL */
    private function collectSources(): array
    {
        $sources = [];

        foreach (config('nplcloud.entities', []) as $definition) {
            $columns = (array) ($definition['media'] ?? []);
            if ($columns === []) {
                continue;
            }

            $table = (string) $definition['table'];

            foreach (DB::table($table)->get() as $row) {
                foreach ($columns as $column) {
                    $url = $row->{$column} ?? null;
                    if (is_string($url) && $url !== '') {
                        $sources[$this->keyFor($url)] = $url;
                    }
                }
            }
        }

        return $sources;
    }

    private function tempPath(string $key): string
    {
        return $this->rootPath().DIRECTORY_SEPARATOR.'_tmp'.DIRECTORY_SEPARATOR.$key.'.bin';
    }

    private function extensionFor(?string $mime, string $url): string
    {
        $byMime = match (true) {
            $mime === null => null,
            str_contains($mime, 'png') => 'png',
            str_contains($mime, 'webp') => 'webp',
            str_contains($mime, 'gif') => 'gif',
            str_contains($mime, 'svg') => 'svg',
            str_contains($mime, 'jpeg'), str_contains($mime, 'jpg') => 'jpg',
            default => null,
        };

        if ($byMime !== null) {
            return $byMime;
        }

        $fromUrl = strtolower(pathinfo(parse_url($url, PHP_URL_PATH) ?: '', PATHINFO_EXTENSION));

        return in_array($fromUrl, ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'], true) ? $fromUrl : 'img';
    }
}
