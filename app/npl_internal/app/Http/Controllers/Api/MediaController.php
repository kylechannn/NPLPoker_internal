<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Services\Media\MediaCacheService;
use Illuminate\Support\Facades\DB;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;

/**
 * Serves a cached image by its media key — the local "shortcut" the UI uses
 * instead of the cloud URL, so the venue keeps working offline.
 */
final class MediaController
{
    public function __construct(private readonly MediaCacheService $media) {}

    public function show(string $key): Response
    {
        $row = DB::table('media_cache')->where('media_key', $key)->first();

        if ($row === null || $row->status !== 'ok' || ! $row->local_path) {
            return response('Not found', 404);
        }

        $path = $this->media->rootPath().DIRECTORY_SEPARATOR.$row->local_path;

        if (! is_file($path)) {
            return response('Not found', 404);
        }

        return (new BinaryFileResponse($path))
            ->setContentDisposition('inline')
            // Content-addressed: the bytes for a key never change, so this is
            // safe to cache hard.
            ->setMaxAge(31536000)
            ->setPublic();
    }
}
