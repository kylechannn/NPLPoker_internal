<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudException;
use App\Services\Cloud\LicenseKeyProvider;
use App\Services\Media\AvatarInstaller;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * Coordinates a whole manual update: acquire the lock, walk the entity
 * manifest in dependency order, cache media, record progress.
 *
 * Two EdgeHost behaviours are deliberately dropped:
 *  - it held BOTH an flock file lock and a DB lock row, which could disagree
 *    (the flock is per-PHP-process and useless across a FastCGI pool); one
 *    TTL'd DB lock is the single arbiter here;
 *  - it ran the whole pull inside the operator's HTTP request with
 *    `timeout: 0`, so the UI could never learn the outcome of a long run.
 *    Here `start()` returns a run id immediately and the UI polls it.
 */
final class ManualUpdateRunner
{
    private const LOCK_NAME = 'manual_update';

    private const LOCK_TTL_MINUTES = 20;

    public function __construct(
        private readonly SyncService $sync,
        private readonly DeltaSyncService $delta,
        private readonly AvatarInstaller $avatars,
        private readonly HeartbeatService $heartbeat,
        private readonly LicenseKeyProvider $license,
    ) {}

    /** Create the run row and execute it inline (CLI and tests). */
    public function start(?string $triggerSource = null): array
    {
        return $this->run($this->createRun($triggerSource));
    }

    /**
     * Create the run row and execute it in a DETACHED php process, returning
     * the queued run for the caller to poll.
     *
     * The desktop host serves the app through `php artisan serve`, whose
     * built-in server is single-threaded on Windows (PHP_CLI_SERVER_WORKERS
     * needs fork). Running the whole pull inside the HTTP request therefore
     * froze every other endpoint for the duration — the desk's requests
     * queued behind it and died as 502s at the gateway.
     */
    public function startInBackground(?string $triggerSource = null): array
    {
        $uuid = $this->createRun($triggerSource);

        // Under phpunit a real child process would run against the live .env,
        // not the test database; inline is also simply what the tests assert.
        if (app()->runningUnitTests() || ! $this->spawn($uuid)) {
            return $this->run($uuid);
        }

        return $this->status($uuid);
    }

    private function createRun(?string $triggerSource): string
    {
        if (! $this->license->isActivated()) {
            throw new CloudException(CloudException::UNAUTHORISED, 'This install is not activated. Enter the CD-Key first.');
        }

        $uuid = (string) Str::uuid();

        DB::table('sync_runs')->insert([
            'uuid' => $uuid,
            'trigger_source' => $triggerSource,
            'status' => 'queued',
            'progress' => 0,
            'stage' => 'queued',
            'entities_total' => count($this->orderedEntities()),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        return $uuid;
    }

    /** Launch `artisan sync:run {uuid}` detached from this request. */
    private function spawn(string $uuid): bool
    {
        $artisan = base_path('artisan');

        if (PHP_OS_FAMILY === 'Windows') {
            // `start /B` detaches; popen+pclose returns as soon as cmd has
            // spawned it. proc_open is unusable here — its destructor waits
            // for the child, which would re-block the request.
            $command = sprintf(
                'start /B "" %s %s sync:run %s',
                escapeshellarg(PHP_BINARY),
                escapeshellarg($artisan),
                escapeshellarg($uuid),
            );
            $handle = @popen($command, 'r');
            if ($handle === false) {
                return false;
            }
            pclose($handle);

            return true;
        }

        $command = sprintf(
            '%s %s sync:run %s > /dev/null 2>&1 &',
            escapeshellarg(PHP_BINARY),
            escapeshellarg($artisan),
            escapeshellarg($uuid),
        );
        @exec($command, $output, $status);

        return $status === 0;
    }

    /** Execute the run. Safe to call from the CLI or a queued job. */
    public function run(string $uuid, bool $force = false): array
    {
        $owner = gethostname().':'.getmypid();

        if (! $this->acquireLock($owner)) {
            $this->fail($uuid, 'MANUAL_UPDATE_ALREADY_RUNNING', 'Another manual update is already running.');

            return $this->status($uuid);
        }

        $entities = $this->orderedEntities();
        $summary = [];
        $rowsWritten = 0;
        $warnings = [];

        $this->update($uuid, [
            'status' => 'running',
            'stage' => 'syncing',
            'started_at' => now(),
        ]);

        try {
            foreach ($entities as $index => $entity) {
                $this->renewLock($owner);
                $this->update($uuid, [
                    'stage' => 'syncing:'.$entity,
                    // Progress is DERIVED from work completed, not a hardcoded
                    // constant — EdgeHost showed "12%" for minutes on a big pull.
                    'progress' => (int) floor(($index / max(1, count($entities))) * 80),
                ]);

                try {
                    // Big, slow-changing tables come down as deltas; the rest
                    // are small enough to replace wholesale.
                    if ($this->delta->supports($entity)) {
                        $result = $this->delta->sync($entity, $force);
                        $summary[$entity] = $result;
                        $rowsWritten += (int) $result['upserted'];
                    } else {
                        $result = $this->sync->syncEntity($entity, $force);
                        $summary[$entity] = $result;
                        $rowsWritten += (int) $result['rows'];
                    }
                } catch (Throwable $e) {
                    // One bad entity degrades the run to "partial" instead of
                    // losing every other entity's work.
                    $warnings[$entity] = $e->getMessage();
                    $summary[$entity] = [
                        'entity' => $entity,
                        'status' => 'failed',
                        'rows' => 0,
                        'not_modified' => false,
                        'message' => Str::limit($e->getMessage(), 300),
                    ];
                }

                $this->update($uuid, ['entities_done' => $index + 1, 'rows_written' => $rowsWritten]);
            }

            if (count($warnings) === count($entities)) {
                throw new CloudException(
                    CloudException::UNREACHABLE,
                    'No entity could be synced: '.implode(' | ', array_slice($warnings, 0, 2)),
                );
            }

            $this->renewLock($owner);
            $this->update($uuid, ['stage' => 'avatars', 'progress' => 84]);
            $avatars = $this->avatars->installAll($force);

            $this->renewLock($owner);
            $this->update($uuid, ['stage' => 'media', 'progress' => 92]);
            $media = $this->sync->syncMedia($force);
            $media['avatars'] = $avatars;

            $this->update($uuid, [
                'status' => $warnings === [] ? 'succeeded' : 'partial',
                'stage' => 'complete',
                'progress' => 100,
                'rows_written' => $rowsWritten,
                'media_downloaded' => $media['downloaded'],
                'media_skipped' => $media['skipped'],
                'summary' => json_encode([
                    'entities' => $summary,
                    'media' => $media,
                    'warnings' => $warnings,
                ]),
                'finished_at' => now(),
            ]);

            // Tell the cloud where this machine now stands.
            $this->update($uuid, ['stage' => 'reporting']);
            $this->heartbeat->report($warnings === [] ? 'succeeded' : 'partial');
            $this->update($uuid, ['stage' => 'complete']);
        } catch (Throwable $e) {
            $code = $e instanceof CloudException ? $e->errorCode : 'SYNC_FAILED';
            $this->fail($uuid, $code, $e->getMessage(), $summary);
            $this->heartbeat->report('failed');
        } finally {
            $this->releaseLock($owner);
        }

        return $this->status($uuid);
    }

    public function status(string $uuid): array
    {
        $run = DB::table('sync_runs')->where('uuid', $uuid)->first();

        return $run ? $this->present($run) : ['uuid' => $uuid, 'status' => 'unknown'];
    }

    public function latest(): ?array
    {
        $run = DB::table('sync_runs')->orderByDesc('id')->first();

        return $run ? $this->present($run) : null;
    }

    /** Entities in dependency order — parents before their children. */
    public function orderedEntities(): array
    {
        $entities = config('nplcloud.entities', []);
        $ordered = [];

        foreach (array_keys($entities) as $name) {
            $dependency = $entities[$name]['depends_on'] ?? null;

            if ($dependency !== null && ! in_array($dependency, $ordered, true)) {
                $ordered[] = $dependency;
            }

            if (! in_array($name, $ordered, true)) {
                $ordered[] = $name;
            }
        }

        return $ordered;
    }

    private function present(object $run): array
    {
        return [
            'uuid' => $run->uuid,
            'status' => $run->status,
            'stage' => $run->stage,
            'progress' => (int) $run->progress,
            'entities_total' => (int) $run->entities_total,
            'entities_done' => (int) $run->entities_done,
            'rows_written' => (int) $run->rows_written,
            'media_downloaded' => (int) $run->media_downloaded,
            'media_skipped' => (int) $run->media_skipped,
            'summary' => $run->summary ? json_decode($run->summary, true) : null,
            'error' => $run->error,
            'error_code' => $run->error_code,
            'started_at' => $run->started_at,
            'finished_at' => $run->finished_at,
        ];
    }

    private function fail(string $uuid, string $code, string $message, array $summary = []): void
    {
        $this->update($uuid, [
            'status' => 'failed',
            'stage' => 'failed',
            'error' => Str::limit($message, 900),
            'error_code' => $code,
            'summary' => json_encode(['entities' => $summary]),
            'finished_at' => now(),
        ]);
    }

    private function update(string $uuid, array $attributes): void
    {
        DB::table('sync_runs')->where('uuid', $uuid)->update($attributes + ['updated_at' => now()]);
    }

    private function acquireLock(string $owner): bool
    {
        // Clear an expired lock first so a crashed run self-heals.
        DB::table('sync_locks')->where('name', self::LOCK_NAME)->where('expires_at', '<', now())->delete();

        try {
            DB::table('sync_locks')->insert([
                'name' => self::LOCK_NAME,
                'owner' => $owner,
                'acquired_at' => now(),
                'expires_at' => now()->addMinutes(self::LOCK_TTL_MINUTES),
            ]);

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    private function renewLock(string $owner): void
    {
        DB::table('sync_locks')
            ->where('name', self::LOCK_NAME)
            ->where('owner', $owner)
            ->update(['expires_at' => now()->addMinutes(self::LOCK_TTL_MINUTES)]);
    }

    private function releaseLock(string $owner): void
    {
        DB::table('sync_locks')->where('name', self::LOCK_NAME)->where('owner', $owner)->delete();
    }
}
