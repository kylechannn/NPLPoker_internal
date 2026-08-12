<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use App\Services\Media\MediaCacheService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Throwable;

/**
 * Manual update: pull everything from the cloud and replace the local copy.
 *
 * Design differences from the EdgeHost original, all deliberate:
 *
 *  - Writes land in a `_staging` twin first, are row-count verified, then
 *    swapped into the live table inside a SHORT transaction. EdgeHost wiped
 *    live tables inside one long transaction spanning every entity, so the
 *    operational UI blocked (or read half-state) for the whole pull.
 *  - Each entity keeps its own watermark/ETag in `sync_entity_states`, so a
 *    partial failure resumes just that entity instead of restarting the run.
 *  - An empty cloud payload never wipes a populated table; it is refused as
 *    a suspected truncated response.
 *  - Progress is derived from entities completed, not hardcoded constants.
 */
final class SyncService
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly MediaCacheService $media,
    ) {}

    /**
     * Run one entity. Returns a summary row for the run record.
     *
     * @return array{entity: string, status: string, rows: int, not_modified: bool, message: ?string}
     */
    public function syncEntity(string $entity, bool $force = false): array
    {
        $definition = config("nplcloud.entities.{$entity}");

        if (! is_array($definition)) {
            throw new \InvalidArgumentException("Unknown sync entity [{$entity}].");
        }

        $state = $this->state($entity);
        $this->touchState($entity, ['status' => 'running', 'last_attempt_at' => now()]);

        try {
            $rows = $entity === 'seating'
                ? $this->fetchSeatingRows()
                : $this->fetchEntityRows($entity, $definition, $force ? null : ($state->etag ?? null));

            // A null return means the cloud said 304 — nothing changed.
            if ($rows === null) {
                $this->touchState($entity, [
                    'status' => 'fresh',
                    'last_success_at' => now(),
                    'last_error' => null,
                ]);

                return ['entity' => $entity, 'status' => 'not_modified', 'rows' => (int) $state->row_count, 'not_modified' => true, 'message' => null];
            }

            $table = (string) $definition['table'];
            $staging = $table.'_staging';

            // Refuse to replace live data with an empty snapshot: that is far
            // more likely a truncated response than a genuinely emptied table.
            // Seating is the exception — its rows are rebuilt per pull and a
            // quiet day (no sessions today/tomorrow) is legitimately empty;
            // refusing would wedge the entity on yesterday's seat map forever.
            $liveCount = DB::table($table)->count();
            if ($rows === [] && $liveCount > 0 && ! $force && $entity !== 'seating') {
                throw new CloudException(
                    CloudException::BAD_RESPONSE,
                    sprintf('%s returned 0 rows while %d are held locally — refusing to wipe. Re-run with force to override.', $entity, $liveCount),
                );
            }

            DB::table($staging)->delete();
            foreach (array_chunk($rows, 500) as $chunk) {
                DB::table($staging)->insert($chunk);
            }

            $stagedCount = DB::table($staging)->count();
            if ($stagedCount !== count($rows)) {
                throw new CloudException(
                    CloudException::BAD_RESPONSE,
                    sprintf('%s staged %d of %d rows — aborting before swap.', $entity, $stagedCount, count($rows)),
                );
            }

            // Short swap: live is empty and refilled from staging in one go.
            DB::transaction(function () use ($table, $staging): void {
                DB::table($table)->delete();
                DB::statement("INSERT INTO {$table} SELECT * FROM {$staging}");
            }, 3);

            DB::table($staging)->delete();

            $this->touchState($entity, [
                'status' => 'ok',
                'row_count' => $stagedCount,
                'content_hash' => hash('sha256', json_encode($rows) ?: ''),
                'last_success_at' => now(),
                'last_error' => null,
            ]);

            return ['entity' => $entity, 'status' => 'ok', 'rows' => $stagedCount, 'not_modified' => false, 'message' => null];
        } catch (Throwable $e) {
            $this->touchState($entity, ['status' => 'failed', 'last_error' => Str::limit($e->getMessage(), 900)]);
            Log::warning('sync entity failed', ['entity' => $entity, 'error' => $e->getMessage()]);

            throw $e;
        }
    }

    /** Cache every image referenced by the mirrored rows. */
    public function syncMedia(bool $force = false): array
    {
        return $this->media->syncAll($force);
    }

    /**
     * @return list<array<string, mixed>>|null  null when the cloud says 304
     */
    private function fetchEntityRows(string $entity, array $definition, ?string $etag): ?array
    {
        $result = $this->cloud->getJson(
            (string) $definition['endpoint'],
            (array) ($definition['query'] ?? []),
            $etag,
        );

        if ($result['not_modified']) {
            return null;
        }

        if ($result['etag']) {
            $this->touchState($entity, ['etag' => $result['etag']]);
        }

        $records = $this->extractRecords($result['data']);
        $now = now();

        return match ($entity) {
            'venues' => array_map(fn (array $row): array => [
                'cloud_id' => (int) ($row['id'] ?? 0),
                'venue_name' => $this->str($row['venue_name'] ?? $row['name'] ?? null, 160),
                'state_code' => $this->str($row['state_code'] ?? $row['state'] ?? null, 16),
                'suburb' => $this->str($row['suburb'] ?? null, 120),
                'address_line1' => $this->str($row['address_line1'] ?? null, 200),
                'image_url' => $this->str($row['image_url'] ?? null, 500),
                'media_key' => isset($row['image_url']) ? $this->media->keyFor((string) $row['image_url']) : null,
                'payload' => json_encode($row),
                'created_at' => $now,
                'updated_at' => $now,
            ], $records),

            'game_sessions' => array_map(fn (array $row): array => [
                'session_id' => (int) ($row['session_id'] ?? $row['id'] ?? 0),
                'source_type' => $this->str($row['source_type'] ?? null, 20),
                'source_id' => isset($row['source_id']) ? (int) $row['source_id'] : null,
                'category' => $this->str($row['category'] ?? null, 20),
                'venue_id' => isset($row['venue_id']) ? (int) $row['venue_id'] : null,
                'venue_name' => $this->str($row['venue_name'] ?? null, 160),
                'title' => $this->str($row['title'] ?? null, 200),
                'session_date' => $this->str($row['session_date'] ?? null, 10),
                'start_time' => $this->str($row['start_time'] ?? null, 8),
                'status' => $this->str($row['status'] ?? null, 20),
                'max_players' => isset($row['max_players']) ? (int) $row['max_players'] : null,
                'registrations_count' => (int) ($row['registrations_count'] ?? 0),
                'is_open_for_registration' => (bool) ($row['is_open_for_registration'] ?? false),
                // The game's payout ladder, shown by the room clock.
                'prize_breakdown' => isset($row['prize_breakdown']) && is_array($row['prize_breakdown'])
                    ? json_encode($row['prize_breakdown'])
                    : null,
                // This session's own winner-voucher ladder — configured
                // per session on the admin console, not per venue.
                'winner_vouchers' => isset($row['winner_vouchers']) && is_array($row['winner_vouchers'])
                    ? json_encode($row['winner_vouchers'])
                    : null,
                'image_url' => $this->str($row['image_url'] ?? $row['hero_image_url'] ?? null, 500),
                'media_key' => isset($row['image_url']) ? $this->media->keyFor((string) $row['image_url']) : null,
                'payload' => json_encode($row),
                'created_at' => $now,
                'updated_at' => $now,
            ], $records),

            default => throw new \InvalidArgumentException("No row mapper for [{$entity}]."),
        };
    }

    /**
     * Seating is fanned out per mirrored session — the cloud exposes it one
     * session at a time. Runs after game_sessions (see `depends_on`).
     *
     * @return list<array<string, mixed>>
     */
    private function fetchSeatingRows(): array
    {
        // The full Manual-update path covers every scheduled session in the
        // mirror window — a desk may open any of them. (The realtime pull
        // uses refreshSeatingFor(), which scopes to one venue and refreshes
        // incrementally instead of replacing the whole table.)
        $sessionIds = DB::table('mirror_game_sessions')
            ->where('status', 'scheduled')
            ->orderBy('session_date')
            ->pluck('session_id');

        $rows = [];
        $now = now();

        foreach ($sessionIds as $sessionId) {
            try {
                $result = $this->cloud->getJson("/api/v1/game-sessions/{$sessionId}/seating");
            } catch (CloudException $e) {
                // A session that vanished between the sessions pull and this
                // fan-out (completed, cancelled) must not abort the whole
                // seating sync; connectivity loss must.
                if ($e->isRetryable()) {
                    throw $e;
                }

                continue;
            }

            $seating = $result['data'];

            foreach ((array) ($seating['tables'] ?? []) as $table) {
                $tableNumber = (int) ($table['table_number'] ?? 0);

                foreach ((array) ($table['seats'] ?? []) as $seat) {
                    $player = $seat['player'] ?? null;
                    $seatNumber = (int) ($seat['seat_number'] ?? 0);

                    $rows[] = [
                        'session_table_key' => sprintf('%d:%d:%d', $sessionId, $tableNumber, $seatNumber),
                        'session_id' => (int) $sessionId,
                        'table_number' => $tableNumber,
                        'seat_number' => $seatNumber,
                        'table_status' => $this->str($table['status'] ?? null, 20),
                        'max_seats' => (int) ($table['max_seats'] ?? 8),
                        'table_kind' => $this->str($table['kind'] ?? null, 10),
                        'creator_npl_id' => $this->str($table['creator']['npl_id'] ?? null, 32),
                        'creator_display_name' => $this->str($table['creator']['display_name'] ?? null, 120),
                        'game_mode' => $this->str($table['game_mode'] ?? null, 60),
                        'blinds_text' => $this->str($table['blinds_text'] ?? null, 60),
                        'rules_text' => $this->str($table['rules_text'] ?? null, 500),
                        'allow_strangers' => isset($table['allow_strangers']) ? (bool) $table['allow_strangers'] : null,
                        'activation_deadline_at' => $this->str($table['activation_deadline_at'] ?? null, 40),
                        'activated_at' => $this->str($table['activated_at'] ?? null, 40),
                        'player_npl_id' => $player ? $this->str($player['npl_id'] ?? null, 32) : null,
                        'player_display_name' => $player ? $this->str($player['display_name'] ?? null, 120) : null,
                        'registration_status' => $player ? 'registered' : null,
                        'pre_registered' => $player ? (bool) ($player['pre_registered'] ?? false) : null,
                        'waitlist_position' => null,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ];
                }

                foreach ((array) ($table['waitlist'] ?? []) as $entry) {
                    $player = $entry['player'] ?? null;
                    $position = (int) ($entry['position'] ?? 0);

                    $rows[] = [
                        'session_table_key' => sprintf('%d:%d:w%d', $sessionId, $tableNumber, $position),
                        'session_id' => (int) $sessionId,
                        'table_number' => $tableNumber,
                        'seat_number' => null,
                        'table_status' => $this->str($table['status'] ?? null, 20),
                        'max_seats' => (int) ($table['max_seats'] ?? 8),
                        'table_kind' => $this->str($table['kind'] ?? null, 10),
                        'creator_npl_id' => $this->str($table['creator']['npl_id'] ?? null, 32),
                        'creator_display_name' => $this->str($table['creator']['display_name'] ?? null, 120),
                        'game_mode' => $this->str($table['game_mode'] ?? null, 60),
                        'blinds_text' => $this->str($table['blinds_text'] ?? null, 60),
                        'rules_text' => $this->str($table['rules_text'] ?? null, 500),
                        'allow_strangers' => isset($table['allow_strangers']) ? (bool) $table['allow_strangers'] : null,
                        'activation_deadline_at' => $this->str($table['activation_deadline_at'] ?? null, 40),
                        'activated_at' => $this->str($table['activated_at'] ?? null, 40),
                        'player_npl_id' => $player ? $this->str($player['npl_id'] ?? null, 32) : null,
                        'player_display_name' => $player ? $this->str($player['display_name'] ?? null, 120) : null,
                        'registration_status' => 'waitlisted',
                        'pre_registered' => $player ? (bool) ($player['pre_registered'] ?? false) : null,
                        'waitlist_position' => $position,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ];
                }
            }
        }

        return $rows;
    }

    /** Cloud list endpoints answer either {data: [...]} or a bare list. */
    /**
     * Incremental seating refresh for the realtime pull: fetch the seat
     * maps for the venue's scheduled sessions (or an explicit list) and
     * replace ONLY those sessions' rows — other venues' rows stay put.
     * This is what lets a signal-triggered pull cost a handful of HTTP
     * calls instead of one per session network-wide.
     *
     * @param  list<int>|null  $sessionIds
     * @return array{sessions: int, rows: int}
     */
    /**
     * Mirrors one club's member register from the cloud — full snapshot
     * replace, so removals disappear too. Called after every membership
     * write and whenever the Membership tab loads.
     */
    public function refreshClubMemberships(int $venueId): int
    {
        $result = $this->cloud->getJson('/api/v1/internal/club-memberships', ['venue_id' => $venueId]);

        $now = now();
        $rows = collect((array) ($result['data']['memberships'] ?? []))
            ->filter(fn ($row): bool => is_array($row) && isset($row['id'], $row['npl_id']))
            ->map(fn (array $row): array => [
                'cloud_id' => (int) $row['id'],
                'venue_id' => $venueId,
                'player_id' => isset($row['player_id']) ? (int) $row['player_id'] : null,
                'npl_id' => (string) $row['npl_id'],
                'display_name' => $this->str($row['display_name'] ?? null, 190),
                'club_member_code' => $this->str($row['club_member_code'] ?? null, 100) ?? '',
                'status' => $this->str($row['status'] ?? null, 20) ?? 'active',
                'valid' => (bool) ($row['valid'] ?? false),
                'joined_at' => $this->str($row['joined_at'] ?? null, 10),
                'expires_at' => $this->str($row['expires_at'] ?? null, 10),
                'notes' => $this->str($row['notes'] ?? null, 2000),
                'created_at' => $now,
                'updated_at' => $now,
            ])
            ->values();

        DB::transaction(function () use ($venueId, $rows): void {
            DB::table('mirror_club_memberships')->where('venue_id', $venueId)->delete();

            foreach ($rows->chunk(200) as $chunk) {
                DB::table('mirror_club_memberships')->insert($chunk->all());
            }
        });

        return $rows->count();
    }

    public function refreshSeatingFor(?int $venueId = null, ?array $sessionIds = null): array
    {
        $ids = $sessionIds !== null
            ? collect($sessionIds)->map(fn ($id): int => (int) $id)->values()
            : DB::table('mirror_game_sessions')
                ->where('status', 'scheduled')
                ->when($venueId !== null, fn ($query) => $query->where('venue_id', $venueId))
                ->orderBy('session_date')
                ->pluck('session_id')
                ->map(fn ($id): int => (int) $id)
                ->values();

        if ($ids->isEmpty()) {
            return ['sessions' => 0, 'rows' => 0];
        }

        $now = now();
        $rowsBySession = [];

        foreach ($ids as $sessionId) {
            try {
                $result = $this->cloud->getJson("/api/v1/game-sessions/{$sessionId}/seating");
            } catch (CloudException $e) {
                if ($e->isRetryable()) {
                    throw $e;
                }

                // Vanished mid-refresh (completed/cancelled): clear its rows.
                $rowsBySession[$sessionId] = [];

                continue;
            }

            $seating = $result['data'];
            $rows = [];

            foreach ((array) ($seating['tables'] ?? []) as $table) {
                $tableNumber = (int) ($table['table_number'] ?? 0);

                foreach ((array) ($table['seats'] ?? []) as $seat) {
                    $player = $seat['player'] ?? null;
                    $seatNumber = (int) ($seat['seat_number'] ?? 0);

                    $rows[] = [
                        'session_table_key' => sprintf('%d:%d:%d', $sessionId, $tableNumber, $seatNumber),
                        'session_id' => $sessionId,
                        'table_number' => $tableNumber,
                        'seat_number' => $seatNumber,
                        'table_status' => $this->str($table['status'] ?? null, 20),
                        'max_seats' => (int) ($table['max_seats'] ?? 8),
                        'table_kind' => $this->str($table['kind'] ?? null, 10),
                        'creator_npl_id' => $this->str($table['creator']['npl_id'] ?? null, 32),
                        'creator_display_name' => $this->str($table['creator']['display_name'] ?? null, 120),
                        'game_mode' => $this->str($table['game_mode'] ?? null, 60),
                        'blinds_text' => $this->str($table['blinds_text'] ?? null, 60),
                        'rules_text' => $this->str($table['rules_text'] ?? null, 500),
                        'allow_strangers' => isset($table['allow_strangers']) ? (bool) $table['allow_strangers'] : null,
                        'activation_deadline_at' => $this->str($table['activation_deadline_at'] ?? null, 40),
                        'activated_at' => $this->str($table['activated_at'] ?? null, 40),
                        'player_npl_id' => $player ? $this->str($player['npl_id'] ?? null, 32) : null,
                        'player_display_name' => $player ? $this->str($player['display_name'] ?? null, 120) : null,
                        'registration_status' => $player ? 'registered' : null,
                        'pre_registered' => $player ? (bool) ($player['pre_registered'] ?? false) : null,
                        'waitlist_position' => null,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ];
                }

                foreach ((array) ($table['waitlist'] ?? []) as $entry) {
                    $player = $entry['player'] ?? null;
                    $position = (int) ($entry['position'] ?? 0);

                    $rows[] = [
                        'session_table_key' => sprintf('%d:%d:w%d', $sessionId, $tableNumber, $position),
                        'session_id' => $sessionId,
                        'table_number' => $tableNumber,
                        'seat_number' => null,
                        'table_status' => $this->str($table['status'] ?? null, 20),
                        'max_seats' => (int) ($table['max_seats'] ?? 8),
                        'table_kind' => $this->str($table['kind'] ?? null, 10),
                        'creator_npl_id' => $this->str($table['creator']['npl_id'] ?? null, 32),
                        'creator_display_name' => $this->str($table['creator']['display_name'] ?? null, 120),
                        'game_mode' => $this->str($table['game_mode'] ?? null, 60),
                        'blinds_text' => $this->str($table['blinds_text'] ?? null, 60),
                        'rules_text' => $this->str($table['rules_text'] ?? null, 500),
                        'allow_strangers' => isset($table['allow_strangers']) ? (bool) $table['allow_strangers'] : null,
                        'activation_deadline_at' => $this->str($table['activation_deadline_at'] ?? null, 40),
                        'activated_at' => $this->str($table['activated_at'] ?? null, 40),
                        'player_npl_id' => $player ? $this->str($player['npl_id'] ?? null, 32) : null,
                        'player_display_name' => $player ? $this->str($player['display_name'] ?? null, 120) : null,
                        'registration_status' => 'waitlisted',
                        'pre_registered' => $player ? (bool) ($player['pre_registered'] ?? false) : null,
                        'waitlist_position' => $position,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ];
                }
            }

            $rowsBySession[$sessionId] = $rows;
        }

        $written = 0;

        DB::transaction(function () use ($rowsBySession, &$written): void {
            foreach ($rowsBySession as $sessionId => $rows) {
                DB::table('mirror_session_tables')->where('session_id', $sessionId)->delete();

                foreach (array_chunk($rows, 100) as $chunk) {
                    DB::table('mirror_session_tables')->insert($chunk);
                    $written += count($chunk);
                }
            }
        });

        $this->touchState('seating', [
            'status' => 'ok',
            'row_count' => DB::table('mirror_session_tables')->count(),
            'last_success_at' => now(),
            'last_attempt_at' => now(),
            'last_error' => null,
        ]);

        return ['sessions' => count($rowsBySession), 'rows' => $written];
    }

    private function extractRecords(array $data): array
    {
        if (isset($data['data']) && is_array($data['data'])) {
            return array_values(array_filter($data['data'], 'is_array'));
        }

        return array_values(array_filter($data, 'is_array'));
    }

    private function str(mixed $value, int $limit): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return mb_substr((string) $value, 0, $limit);
    }

    public function state(string $entity): object
    {
        $row = DB::table('sync_entity_states')->where('entity', $entity)->first();

        if ($row === null) {
            DB::table('sync_entity_states')->insert([
                'entity' => $entity,
                'status' => 'idle',
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            $row = DB::table('sync_entity_states')->where('entity', $entity)->first();
        }

        return $row;
    }

    private function touchState(string $entity, array $attributes): void
    {
        $this->state($entity);

        DB::table('sync_entity_states')
            ->where('entity', $entity)
            ->update($attributes + ['updated_at' => now()]);
    }
}
