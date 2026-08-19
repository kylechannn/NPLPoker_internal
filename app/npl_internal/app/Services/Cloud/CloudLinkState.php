<?php

declare(strict_types=1);

namespace App\Services\Cloud;

use Carbon\CarbonImmutable;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The single answer to "can this desk reach the NPL cloud right now?".
 *
 * Detection is passive — every CloudClient call reports its outcome here,
 * so a healthy venue never pays an extra request. While the link is down,
 * cloud calls fail fast instead of holding the desk's only PHP worker
 * through a 10s connect timeout, and both queues pause without spending
 * retry budget: a weekend outage must never dead-letter a paid buy-in.
 *
 * Recovery is an explicit, cheap probe of the cloud's /up health route,
 * run by the 15s drain sweeps and the UI's status poll. The moment it
 * succeeds, queue entries parked in leftover backoff are released so the
 * very next drain sends everything.
 *
 * State lives in the database cache store, so the serve worker, the
 * schedule:work process and detached sync runs all share one verdict.
 */
final class CloudLinkState
{
    private const STATE_KEY = 'cloud_link.state';

    private const OFFLINE_SINCE_KEY = 'cloud_link.offline_since';

    private const LAST_OK_KEY = 'cloud_link.last_ok_at';

    private const LAST_PROBE_KEY = 'cloud_link.last_probe_at';

    /** Seconds between recovery probes while offline. */
    private const PROBE_INTERVAL = 15;

    public function isOffline(): bool
    {
        return Cache::get(self::STATE_KEY) === 'offline';
    }

    /** What the operator's status chip shows about the link itself. */
    public function snapshot(): array
    {
        $offline = $this->isOffline();

        return [
            'state' => $offline ? 'offline' : 'online',
            'offline_since' => $offline ? Cache::get(self::OFFLINE_SINCE_KEY) : null,
            'last_ok_at' => Cache::get(self::LAST_OK_KEY),
        ];
    }

    /** Any real answer from the cloud proves the link, errors included. */
    public function markOnline(): void
    {
        $wasOffline = $this->isOffline();

        // Throttle the bookkeeping write: the 5s clock broadcast would
        // otherwise add a cache write to every push for no new information.
        $lastOk = Cache::get(self::LAST_OK_KEY);
        if ($wasOffline || ! is_string($lastOk) || CarbonImmutable::parse($lastOk)->addSeconds(60)->isPast()) {
            Cache::put(self::LAST_OK_KEY, now()->toIso8601String(), now()->addDays(30));
        }

        if (! $wasOffline) {
            return;
        }

        Cache::put(self::STATE_KEY, 'online', now()->addDays(30));
        Cache::forget(self::OFFLINE_SINCE_KEY);
        Log::info('cloud link restored — releasing paused queue entries');
        $this->releaseParkedEntries();
    }

    public function markOffline(): void
    {
        // A failed dial doubles as a probe: the next one is not due yet.
        Cache::put(self::LAST_PROBE_KEY, now()->toIso8601String(), now()->addDays(30));

        if ($this->isOffline()) {
            return;
        }

        Cache::put(self::STATE_KEY, 'offline', now()->addDays(30));
        Cache::put(self::OFFLINE_SINCE_KEY, now()->toIso8601String(), now()->addDays(30));
        Log::info('cloud link lost — cloud queues paused, desk keeps working');
    }

    /**
     * Probe only when offline and enough time has passed since the last
     * dial, so a burst of gated callers costs one probe per interval.
     * Returns true when the cloud is (back) within reach.
     */
    public function probeIfDue(): bool
    {
        if (! $this->isOffline()) {
            return true;
        }

        $last = Cache::get(self::LAST_PROBE_KEY);
        if (is_string($last) && CarbonImmutable::parse($last)->addSeconds(self::PROBE_INTERVAL)->isFuture()) {
            return false;
        }

        return $this->probe();
    }

    /**
     * One cheap dial at the cloud's framework /up route: 3s to connect,
     * and ANY HTTP answer counts as alive — reachability is the question
     * here, not application health.
     */
    public function probe(): bool
    {
        Cache::put(self::LAST_PROBE_KEY, now()->toIso8601String(), now()->addDays(30));

        try {
            Http::withOptions(['verify' => $this->verify()])
                ->connectTimeout(3)
                ->timeout(5)
                ->get(rtrim((string) config('nplcloud.base'), '/').'/up');
        } catch (ConnectionException) {
            return false;
        } catch (Throwable) {
            return false;
        }

        $this->markOnline();

        return true;
    }

    /**
     * Entries that backed off while the link was down would otherwise sit
     * out up to an hour of leftover delay after it returns — make them due
     * now so the next drain sends everything immediately. Attempt counts
     * are preserved: a genuine server-side rejection resumes its ladder.
     */
    private function releaseParkedEntries(): void
    {
        try {
            foreach (['sync_outbox', 'cloud_call_queue'] as $table) {
                DB::table($table)
                    ->where('status', 'pending')
                    ->where('available_at', '>', now())
                    ->update(['available_at' => now(), 'updated_at' => now()]);
            }
        } catch (Throwable) {
            // Backoff timers expire on their own; the release is best-effort.
        }
    }

    /** Same trust roots as CloudClient — the portable php.exe has no store. */
    private function verify(): bool|string
    {
        if (! config('nplcloud.verify_ssl', true)) {
            return false;
        }

        $bundle = (string) (config('nplcloud.ca_bundle') ?: base_path('resources/certs/cacert.pem'));

        return is_file($bundle) ? $bundle : true;
    }
}
