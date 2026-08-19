<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudLinkState;
use App\Services\Cloud\LicenseKeyProvider;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Pushes the venue's clock to the cloud so players can follow the blinds on
 * their phones.
 *
 * Never throws: a venue with flaky internet must keep running its
 * tournament. A missed push self-heals, because the next state change sends
 * the full picture again rather than a delta.
 */
final class TournamentBroadcaster
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly TournamentClockService $clock,
        private readonly TournamentService $tournaments,
        private readonly LicenseKeyProvider $license,
        private readonly TournamentGateService $gates,
        private readonly CloudLinkState $link,
    ) {}

    public function publish(int $sessionId): bool
    {
        if (! $this->license->isActivated()) {
            return false;
        }

        // Paused, not an error: the clock keeps running locally, and the
        // first sweep after the link returns broadcasts the full picture
        // again. Skipping here keeps the 5s sweep from dialing a doomed
        // connect timeout (and logging it) all night.
        if ($this->link->isOffline()) {
            return false;
        }

        try {
            $state = $this->clock->state($sessionId);
            $summary = $this->tournaments->summary($sessionId);
            $session = $this->clock->session($sessionId);

            // Cash desks report too — their Start drives the cloud's
            // pre-registration purge — flagged so the public live feed
            // filters them out.
            $this->cloud->postJson('/api/v1/internal/tournament/state', [
                'game_type' => ($session->game_type ?? 'tournament') === 'cash' ? 'cash' : 'tournament',
                // Stable per device + local tournament, so a re-report
                // updates rather than duplicating.
                'tournament_uid' => $this->uid($sessionId),
                'name' => $state['name'],
                'venue_name' => $state['venue_name'],
                'game_session_id' => $session->game_session_id,
                'status' => $state['status'],

                'level_index' => $state['level_index'],
                'level_count' => $state['level_count'],
                'level_label' => $state['current_level']['label'] ?? null,
                'is_break' => (bool) ($state['current_level']['is_break'] ?? false),
                'small_blind' => (int) ($state['current_level']['small_blind'] ?? 0),
                'big_blind' => (int) ($state['current_level']['big_blind'] ?? 0),
                'ante' => (int) ($state['current_level']['ante'] ?? 0),
                'bb_ante' => (int) ($state['current_level']['bb_ante'] ?? 0),
                'next_level' => $state['next_level'],
                // {label, in_ms, on_break} — the cloud re-derives the
                // countdown from its own clock so it ages between reports.
                'next_break' => $state['next_break'] ?? null,

                'level_started_at' => $state['level_started_at'],
                'paused_at' => $state['paused_at'],
                'pause_accum_ms' => $state['pause_accum_ms'],
                'level_duration_ms' => $state['level_duration_ms'],

                'players_total' => $summary['total_players'],
                'players_active' => $summary['active_players'],
                'rebuys_count' => (int) ($summary['total_rebuys'] ?? 0),
                'addons_count' => (int) ($summary['total_addons'] ?? 0),
                'average_stack' => $summary['average_stack'],
                'total_chips' => $summary['total_chips'],
                'registration_open' => $state['registration_open'],
                // Cut-offs travel with the clock so the website and the phone
                // apps can run the same countdown the room is watching,
                // including the pauses.
                'gates' => $this->gates->gates($sessionId, $session, $state),
                // The desk's own prices — the admin phone's resolve sheet
                // prefills from these ("based on that session's setting").
                'pricing' => [
                    'buy_in_cents' => (int) ($session->buy_in_price_cents ?? 0),
                    'starting_stack' => (int) ($session->starting_stack ?? 0),
                    'rebuy_tiers' => TournamentService::rebuyTiers($session),
                    'addon_tiers' => TournamentService::addonTiers($session),
                ],
                'started_at' => $state['started_at'],
                'finished_at' => $state['finished_at'],
            ]);

            return true;
        } catch (Throwable $e) {
            Log::info('tournament broadcast skipped', ['session' => $sessionId, 'error' => $e->getMessage()]);

            return false;
        }
    }

    /**
     * The cloud-facing identity of a local session. Public because the
     * Admin QR must encode EXACTLY the uid the broadcasts use — composing
     * it anywhere else risks the two drifting apart.
     */
    public function uid(int $sessionId): string
    {
        $device = $this->license->deviceId() ?: 'unknown';
        $uuid = DB::table('tournament_sessions')->where('id', $sessionId)->value('uuid');

        return sprintf('npl:%s:%s', $device, substr((string) $uuid, 0, 8));
    }
}
