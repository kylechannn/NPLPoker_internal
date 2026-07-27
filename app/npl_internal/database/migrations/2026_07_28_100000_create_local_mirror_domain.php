<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Local mirror of NPL cloud data.
 *
 * Every mirror table has an identical `_staging` twin. A manual update
 * writes only to staging, verifies the row count, then swaps in one short
 * transaction — so the operational UI never reads a half-replaced table.
 * EdgeHost instead wiped the live table inside a long transaction that
 * spanned every entity, which blocked live scoring for the whole pull.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_venues', 'mirror_venues_staging'] as $table) {
            Schema::create($table, function (Blueprint $blueprint) {
                $blueprint->id();
                $blueprint->unsignedBigInteger('cloud_id')->index();
                $blueprint->string('venue_name', 160)->nullable();
                $blueprint->string('state_code', 16)->nullable();
                $blueprint->string('suburb', 120)->nullable();
                $blueprint->string('address_line1', 200)->nullable();
                $blueprint->string('image_url', 500)->nullable();
                $blueprint->string('media_key', 64)->nullable();
                $blueprint->json('payload')->nullable();
                $blueprint->timestamps();
            });
        }

        foreach (['mirror_game_sessions', 'mirror_game_sessions_staging'] as $table) {
            Schema::create($table, function (Blueprint $blueprint) {
                $blueprint->id();
                $blueprint->unsignedBigInteger('session_id')->index();
                $blueprint->string('source_type', 20)->nullable();
                $blueprint->unsignedBigInteger('source_id')->nullable();
                $blueprint->string('category', 20)->nullable()->index();
                $blueprint->unsignedBigInteger('venue_id')->nullable()->index();
                $blueprint->string('venue_name', 160)->nullable();
                $blueprint->string('title', 200)->nullable();
                $blueprint->date('session_date')->nullable()->index();
                $blueprint->string('start_time', 8)->nullable();
                $blueprint->string('status', 20)->nullable();
                $blueprint->unsignedInteger('max_players')->nullable();
                $blueprint->unsignedInteger('registrations_count')->default(0);
                $blueprint->boolean('is_open_for_registration')->default(false);
                $blueprint->string('image_url', 500)->nullable();
                $blueprint->string('media_key', 64)->nullable();
                $blueprint->json('payload')->nullable();
                $blueprint->timestamps();
            });
        }

        // One row per (session, table, seat) — the flattened seating map.
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::create($table, function (Blueprint $blueprint) {
                $blueprint->id();
                $blueprint->string('session_table_key', 64)->index();
                $blueprint->unsignedBigInteger('session_id')->index();
                $blueprint->unsignedSmallInteger('table_number');
                $blueprint->unsignedTinyInteger('seat_number')->nullable();
                $blueprint->string('table_status', 20)->nullable();
                $blueprint->unsignedTinyInteger('max_seats')->default(8);
                $blueprint->string('player_npl_id', 32)->nullable()->index();
                $blueprint->string('player_display_name', 120)->nullable();
                $blueprint->string('registration_status', 20)->nullable();
                $blueprint->unsignedSmallInteger('waitlist_position')->nullable();
                $blueprint->timestamps();
            });
        }

        /**
         * Per-entity resume state. EdgeHost kept ONE shared cursor on the
         * host row, so a partial failure could advance past an entity that
         * never synced. Here each entity carries its own watermark, ETag
         * and last result, and resumes independently.
         */
        Schema::create('sync_entity_states', function (Blueprint $table) {
            $table->id();
            $table->string('entity', 64)->unique();
            $table->string('status', 20)->default('idle');
            $table->string('etag', 200)->nullable();
            $table->string('cursor', 200)->nullable();
            $table->unsignedInteger('row_count')->default(0);
            $table->string('content_hash', 64)->nullable();
            $table->timestamp('last_success_at')->nullable();
            $table->timestamp('last_attempt_at')->nullable();
            $table->text('last_error')->nullable();
            $table->timestamps();
        });

        /** One row per manual update, with derived (not hardcoded) progress. */
        Schema::create('sync_runs', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            $table->string('trigger_source', 120)->nullable();
            $table->string('status', 20)->default('queued')->index();
            $table->unsignedTinyInteger('progress')->default(0);
            $table->string('stage', 40)->nullable();
            $table->unsignedSmallInteger('entities_total')->default(0);
            $table->unsignedSmallInteger('entities_done')->default(0);
            $table->unsignedInteger('rows_written')->default(0);
            $table->unsignedInteger('media_downloaded')->default(0);
            $table->unsignedInteger('media_skipped')->default(0);
            $table->json('summary')->nullable();
            $table->text('error')->nullable();
            $table->string('error_code', 40)->nullable();
            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();
            $table->timestamps();
        });

        /** Advisory lock so two runs cannot overlap; TTL self-heals a crash. */
        Schema::create('sync_locks', function (Blueprint $table) {
            $table->string('name', 64)->primary();
            $table->string('owner', 64);
            $table->timestamp('acquired_at');
            $table->timestamp('expires_at')->index();
        });

        /**
         * Content-addressed media cache. The file name is the content hash,
         * so a changed image lands beside the old one and the swap is atomic;
         * `source_etag` drives conditional re-fetches.
         */
        Schema::create('media_cache', function (Blueprint $table) {
            $table->id();
            $table->string('media_key', 64)->unique();
            $table->string('source_url', 500);
            $table->string('content_hash', 64)->nullable();
            $table->string('local_path', 300)->nullable();
            $table->string('mime', 80)->nullable();
            $table->unsignedInteger('bytes')->default(0);
            $table->string('source_etag', 200)->nullable();
            $table->string('source_last_modified', 120)->nullable();
            $table->string('status', 20)->default('pending')->index();
            $table->text('last_error')->nullable();
            $table->timestamp('last_checked_at')->nullable();
            $table->timestamp('synced_at')->nullable();
            $table->timestamps();
        });

        /** Local changes queued for the cloud, with a real dead-letter state. */
        Schema::create('sync_outbox', function (Blueprint $table) {
            $table->id();
            $table->string('entity_type', 64)->index();
            $table->string('operation', 32);
            $table->string('idempotency_key', 64)->unique();
            $table->json('payload');
            $table->string('status', 20)->default('pending')->index();
            $table->unsignedSmallInteger('attempts')->default(0);
            $table->text('last_error')->nullable();
            $table->timestamp('available_at')->nullable()->index();
            $table->timestamp('sent_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        foreach ([
            'sync_outbox', 'media_cache', 'sync_locks', 'sync_runs', 'sync_entity_states',
            'mirror_session_tables_staging', 'mirror_session_tables',
            'mirror_game_sessions_staging', 'mirror_game_sessions',
            'mirror_venues_staging', 'mirror_venues',
        ] as $table) {
            Schema::dropIfExists($table);
        }
    }
};
