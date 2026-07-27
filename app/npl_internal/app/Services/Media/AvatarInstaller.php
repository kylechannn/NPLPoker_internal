<?php

declare(strict_types=1);

namespace App\Services\Media;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Downloads player avatars and links each one to its mirrored player row,
 * so the desk shows faces instantly and keeps showing them offline.
 *
 * "Install" here means: fetch the bytes once, store them content-addressed,
 * then write the local media key back onto `mirror_players` — that key is
 * the shortcut the UI resolves through `/api/media/{key}`, never the cloud
 * URL. Unchanged avatars cost one conditional request each.
 */
final class AvatarInstaller
{
    public function __construct(private readonly MediaCacheService $media) {}

    /**
     * @return array{installed: int, unchanged: int, failed: int, missing: int}
     */
    public function installAll(bool $force = false): array
    {
        $installed = 0;
        $unchanged = 0;
        $failed = 0;
        $missing = 0;

        DB::table('mirror_players')
            ->select('cloud_id', 'avatar_url', 'avatar_media_key')
            ->orderBy('cloud_id')
            // Chunked so a venue with thousands of members never loads them
            // all into memory at once.
            ->chunk(200, function ($players) use (&$installed, &$unchanged, &$failed, &$missing, $force): void {
                foreach ($players as $player) {
                    $url = trim((string) ($player->avatar_url ?? ''));

                    if ($url === '') {
                        $missing++;

                        if ($player->avatar_media_key !== null) {
                            DB::table('mirror_players')->where('cloud_id', $player->cloud_id)
                                ->update(['avatar_media_key' => null, 'updated_at' => now()]);
                        }

                        continue;
                    }

                    $key = $this->media->keyFor($url);

                    try {
                        $fetched = $this->media->cacheOne($key, $url, $force);
                        $fetched ? $installed++ : $unchanged++;

                        // Link the row to its local copy — this is the shortcut.
                        if ($player->avatar_media_key !== $key) {
                            DB::table('mirror_players')->where('cloud_id', $player->cloud_id)
                                ->update(['avatar_media_key' => $key, 'updated_at' => now()]);
                        }
                    } catch (Throwable $e) {
                        $failed++;
                        Log::warning('avatar install failed', [
                            'player' => $player->cloud_id,
                            'url' => $url,
                            'error' => $e->getMessage(),
                        ]);
                    }
                }
            });

        return [
            'installed' => $installed,
            'unchanged' => $unchanged,
            'failed' => $failed,
            'missing' => $missing,
        ];
    }
}
