<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Poker tournament clock, adapted from EdgeHost's Sichuan module.
 *
 * The important change: EdgeHost's clock lived entirely in the browser —
 * nothing about the current level, remaining time or paused state was ever
 * stored or served, so two open timer windows diverged and a reload lost the
 * tournament. Here the session row IS the clock: `current_level_index`,
 * `level_started_at`, `paused_at` and `pause_accum_ms` make remaining time a
 * pure function of server time, so every display (desk, big screen, phone)
 * agrees and a reload changes nothing.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tournament_sessions', function (Blueprint $table) {
            $table->id();
            $table->uuid('uuid')->unique();
            // Links back to the mirrored cloud session this is hosting.
            $table->unsignedBigInteger('game_session_id')->nullable()->index();
            $table->unsignedBigInteger('game_entity_id')->nullable()->index();
            $table->string('name', 160);
            $table->string('venue_name', 160)->nullable();

            $table->string('status', 16)->default('draft')->index(); // draft|running|paused|finished

            // ---- the clock ----
            $table->unsignedSmallInteger('current_level_index')->default(0);
            $table->timestamp('level_started_at')->nullable();
            $table->timestamp('paused_at')->nullable();
            $table->unsignedBigInteger('pause_accum_ms')->default(0);

            $table->timestamp('started_at')->nullable();
            $table->timestamp('finished_at')->nullable();

            // ---- chip / money config ----
            $table->unsignedInteger('starting_stack')->default(20000);
            $table->unsignedInteger('rebuy_chips')->default(20000);
            $table->unsignedInteger('rebuy_price_cents')->default(0);
            $table->unsignedTinyInteger('max_rebuys_per_player')->default(0); // 0 = unlimited
            $table->unsignedInteger('addon_chips')->default(0);
            $table->unsignedInteger('addon_price_cents')->default(0);
            $table->unsignedTinyInteger('max_addons_per_player')->default(1);
            $table->unsignedInteger('buy_in_price_cents')->default(0);
            $table->unsignedInteger('ko_bounty_cents')->default(0);

            // Late registration / rebuys close at this level index (null = open).
            $table->unsignedSmallInteger('registration_closes_at_level')->nullable();

            $table->json('settings')->nullable();
            $table->timestamps();
        });

        Schema::create('tournament_levels', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tournament_session_id')->constrained('tournament_sessions')->cascadeOnDelete();
            $table->unsignedSmallInteger('level_no');
            // EdgeHost encoded breaks as a `type` string; kept, but poker adds
            // real blind columns instead of one opaque `blind_amount`.
            $table->string('type', 16)->default('blind'); // blind|break
            $table->unsignedBigInteger('small_blind')->default(0);
            $table->unsignedBigInteger('big_blind')->default(0);
            $table->unsignedBigInteger('ante')->default(0);
            $table->unsignedBigInteger('bb_ante')->default(0);
            $table->unsignedSmallInteger('duration_min')->default(20);
            $table->unsignedSmallInteger('sort_order')->default(0);
            $table->string('note', 120)->nullable();
            $table->timestamps();

            $table->unique(['tournament_session_id', 'sort_order'], 'uq_level_order');
            $table->index(['tournament_session_id', 'sort_order']);
        });

        Schema::create('tournament_entries', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tournament_session_id')->constrained('tournament_sessions')->cascadeOnDelete();
            $table->string('player_npl_id', 32)->index();
            $table->string('player_name', 120)->nullable();
            $table->unsignedSmallInteger('table_number')->nullable();
            $table->unsignedTinyInteger('seat_number')->nullable();
            $table->timestamp('joined_at')->nullable();
            $table->timestamps();

            $table->unique(['tournament_session_id', 'player_npl_id'], 'uq_entry_player');
        });

        /**
         * Append-only ledger — buy-ins, rebuys, add-ons, knockouts, bonuses.
         * Voids are negative rows rather than deletes, so the history of what
         * the desk actually did is never rewritten. Alive/dead is derived from
         * the newest ko/unko row (EdgeHost's approach, and a good one).
         */
        Schema::create('tournament_actions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('tournament_session_id')->constrained('tournament_sessions')->cascadeOnDelete();
            $table->string('player_npl_id', 32)->index();
            $table->string('action', 20); // buy_in|rebuy|addon|addon_void|ko|unko|bonus|bonus_void
            $table->bigInteger('chips')->default(0);
            $table->integer('price_cents')->default(0);
            $table->unsignedSmallInteger('level_index')->nullable();
            $table->string('idempotency_key', 64)->nullable()->unique();
            $table->json('meta')->nullable();
            $table->timestamps();

            $table->index(['tournament_session_id', 'player_npl_id']);
            $table->index(['tournament_session_id', 'action']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tournament_actions');
        Schema::dropIfExists('tournament_entries');
        Schema::dropIfExists('tournament_levels');
        Schema::dropIfExists('tournament_sessions');
    }
};
