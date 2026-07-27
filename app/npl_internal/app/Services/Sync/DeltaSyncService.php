<?php

declare(strict_types=1);

namespace App\Services\Sync;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Throwable;

/**
 * Incremental sync for the big, slow-changing tables (players, game
 * entities, relationships).
 *
 * Why this is separate from SyncService's staging-and-swap: a venue holds
 * thousands of players, and re-downloading all of them on every manual
 * update is precisely the wait we are trying to remove. Here we:
 *
 *   1. ask only for rows changed since our watermark (usually zero),
 *   2. page through them with a keyset cursor, upserting in place,
 *   3. reconcile deletions against a cheap id-only list.
 *
 * Steady state for an unchanged entity is a single 304.
 */
final class DeltaSyncService
{
    /** Local mirror shape per entity. */
    private const TABLES = [
        'players' => 'mirror_players',
        'game_entities' => 'mirror_game_entities',
        'player_relationships' => 'mirror_player_relationships',
    ];

    public function __construct(private readonly CloudClient $cloud) {}

    public function supports(string $entity): bool
    {
        return isset(self::TABLES[$entity]);
    }

    /**
     * @return array{entity: string, status: string, upserted: int, deleted: int, pages: int, not_modified: bool}
     */
    public function sync(string $entity, bool $force = false): array
    {
        $table = self::TABLES[$entity] ?? throw new \InvalidArgumentException("Unknown delta entity [{$entity}].");
        $state = $this->state($entity);

        $this->touch($entity, ['status' => 'running', 'last_attempt_at' => now()]);

        try {
            $since = $force ? null : ($state->cursor ?: null);
            $etag = $force ? null : ($state->etag ?: null);

            $upserted = 0;
            $pages = 0;
            $cursor = null;
            $watermark = $since;
            $notModified = false;

            do {
                $result = $this->cloud->getJson(
                    "/api/v1/internal/sync/{$entity}",
                    array_filter([
                        'since' => $since,
                        'cursor' => $cursor,
                        'limit' => 500,
                    ], fn ($value): bool => $value !== null && $value !== ''),
                    // The ETag only guards the first page of a drain.
                    $pages === 0 ? $etag : null,
                );

                if ($result['not_modified']) {
                    $notModified = true;
                    break;
                }

                if ($pages === 0 && $result['etag']) {
                    $this->touch($entity, ['etag' => $result['etag']]);
                }

                $payload = $result['data'];
                $rows = (array) ($payload['upserts'] ?? []);

                if ($rows !== []) {
                    $upserted += $this->upsert($table, $entity, $rows);
                }

                $cursor = $payload['next_cursor'] ?? null;
                $pages++;

                // The cloud only hands back a watermark once the feed drains,
                // so an interrupted run resumes rather than skipping rows.
                if (($payload['watermark'] ?? null) !== null) {
                    $watermark = $payload['watermark'];
                }

                $hasMore = (bool) ($payload['has_more'] ?? false);
            } while ($hasMore && $pages < 200);

            $deleted = $this->reconcileDeletes($entity, $table);

            $this->touch($entity, [
                'status' => 'ok',
                'cursor' => $watermark,
                'row_count' => DB::table($table)->count(),
                'last_success_at' => now(),
                'last_error' => null,
            ]);

            return [
                'entity' => $entity,
                'status' => 'ok',
                'upserted' => $upserted,
                'deleted' => $deleted,
                'pages' => $pages,
                'not_modified' => $notModified,
            ];
        } catch (Throwable $e) {
            $this->touch($entity, ['status' => 'failed', 'last_error' => Str::limit($e->getMessage(), 900)]);

            throw $e;
        }
    }

    /**
     * Delete anything the cloud no longer lists. Cheap: the id feed is a few
     * bytes per row, so this stays affordable even for a big player table.
     */
    private function reconcileDeletes(string $entity, string $table): int
    {
        $result = $this->cloud->getJson("/api/v1/internal/sync/{$entity}/ids");

        if ($result['not_modified']) {
            return 0;
        }

        $liveIds = array_map('intval', (array) ($result['data']['ids'] ?? []));

        // A totally empty id list is far more likely a broken response than a
        // genuinely emptied table — never wipe the venue's data on that.
        if ($liveIds === [] && DB::table($table)->count() > 0) {
            throw new CloudException(
                CloudException::BAD_RESPONSE,
                sprintf('%s returned no live ids while rows are held locally — refusing to delete.', $entity),
            );
        }

        $deleted = 0;

        // Chunked so a large id list never builds one enormous SQL statement.
        DB::table($table)->select('cloud_id')->orderBy('cloud_id')->chunk(1000, function ($rows) use ($table, $liveIds, &$deleted): void {
            $stale = array_diff($rows->pluck('cloud_id')->map('intval')->all(), $liveIds);

            if ($stale !== []) {
                $deleted += DB::table($table)->whereIn('cloud_id', $stale)->delete();
            }
        });

        return $deleted;
    }

    private function upsert(string $table, string $entity, array $rows): int
    {
        $now = now();
        $mapped = [];

        foreach ($rows as $row) {
            $mapped[] = match ($entity) {
                'players' => [
                    'cloud_id' => (int) $row['id'],
                    'npl_id' => $this->str($row['npl_id'] ?? null, 32),
                    'display_name' => $this->str($row['display_name'] ?? null, 120),
                    'first_name' => $this->str($row['first_name'] ?? null, 80),
                    'last_name' => $this->str($row['last_name'] ?? null, 80),
                    'state_code' => $this->str($row['state_code'] ?? null, 16),
                    'avatar_url' => $this->str($row['avatar_url'] ?? null, 500),
                    'status' => $this->str($row['status'] ?? null, 20),
                    'cloud_updated_at' => $row['updated_at'] ?? null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ],

                'game_entities' => [
                    'cloud_id' => (int) $row['id'],
                    'title' => $this->str($row['title'] ?? null, 200),
                    'subtitle' => $this->str($row['subtitle'] ?? null, 200),
                    'game_category' => $this->str($row['game_category'] ?? null, 32),
                    'game_type' => $this->str($row['game_type'] ?? null, 32),
                    'format_code' => $this->str($row['format_code'] ?? null, 32),
                    'venue_id' => isset($row['venue_id']) ? (int) $row['venue_id'] : null,
                    'venue_name' => $this->str($row['venue_name'] ?? null, 160),
                    'day_of_week' => isset($row['day_of_week']) ? (int) $row['day_of_week'] : null,
                    'start_time' => $this->str($row['start_time'] ?? null, 8),
                    'rego_time_start' => $this->str($row['rego_time_start'] ?? null, 8),
                    'rego_time_end' => $this->str($row['rego_time_end'] ?? null, 8),
                    'buy_in_cents' => (int) ($row['buy_in_cents'] ?? 0),
                    'entry_fee_cents' => (int) ($row['entry_fee_cents'] ?? 0),
                    'max_players' => isset($row['max_players']) ? (int) $row['max_players'] : null,
                    'starting_stack' => isset($row['starting_stack']) ? (int) $row['starting_stack'] : null,
                    'default_table_count' => (int) ($row['default_table_count'] ?? 1),
                    'cloud_updated_at' => $row['updated_at'] ?? null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ],

                'player_relationships' => [
                    'cloud_id' => (int) $row['id'],
                    'player_id' => (int) ($row['player_id'] ?? 0),
                    'related_player_id' => (int) ($row['related_player_id'] ?? 0),
                    'type' => $this->str($row['type'] ?? null, 20),
                    'cloud_updated_at' => $row['updated_at'] ?? null,
                    'created_at' => $now,
                    'updated_at' => $now,
                ],

                default => [],
            };
        }

        foreach (array_chunk($mapped, 200) as $chunk) {
            DB::table($table)->upsert($chunk, ['cloud_id']);
        }

        return count($mapped);
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

    private function touch(string $entity, array $attributes): void
    {
        $this->state($entity);

        DB::table('sync_entity_states')->where('entity', $entity)->update($attributes + ['updated_at' => now()]);
    }
}
