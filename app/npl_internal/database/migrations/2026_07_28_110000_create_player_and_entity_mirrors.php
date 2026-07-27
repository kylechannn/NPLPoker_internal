<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Mirrors fed by the cloud's delta feed.
 *
 * These are NOT staged-and-swapped like the snapshot tables: players and
 * game entities arrive as incremental changes, so rows are upserted in place
 * and removals are reconciled against the cloud's id list. Replacing them
 * wholesale would mean re-downloading every player on every update, which is
 * exactly the wait we are avoiding.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mirror_players', function (Blueprint $table) {
            $table->unsignedBigInteger('cloud_id')->primary();
            $table->string('npl_id', 32)->nullable()->index();
            $table->string('display_name', 120)->nullable();
            $table->string('first_name', 80)->nullable();
            $table->string('last_name', 80)->nullable();
            $table->string('state_code', 16)->nullable();
            $table->string('avatar_url', 500)->nullable();
            $table->string('avatar_media_key', 64)->nullable()->index();
            $table->string('status', 20)->nullable();
            $table->timestamp('cloud_updated_at')->nullable()->index();
            $table->timestamps();
        });

        Schema::create('mirror_game_entities', function (Blueprint $table) {
            $table->unsignedBigInteger('cloud_id')->primary();
            $table->string('title', 200)->nullable();
            $table->string('subtitle', 200)->nullable();
            $table->string('game_category', 32)->nullable()->index();
            $table->string('game_type', 32)->nullable();
            $table->string('format_code', 32)->nullable();
            $table->unsignedBigInteger('venue_id')->nullable()->index();
            $table->string('venue_name', 160)->nullable();
            $table->unsignedTinyInteger('day_of_week')->nullable();
            $table->string('start_time', 8)->nullable();
            $table->string('rego_time_start', 8)->nullable();
            $table->string('rego_time_end', 8)->nullable();
            $table->unsignedInteger('buy_in_cents')->default(0);
            $table->unsignedInteger('entry_fee_cents')->default(0);
            $table->unsignedInteger('max_players')->nullable();
            $table->unsignedInteger('starting_stack')->nullable();
            $table->unsignedTinyInteger('default_table_count')->default(1);
            $table->timestamp('cloud_updated_at')->nullable()->index();
            $table->timestamps();
        });

        // Friend/block pairs — the desk must not seat two players who
        // blocked each other at the same table.
        Schema::create('mirror_player_relationships', function (Blueprint $table) {
            $table->unsignedBigInteger('cloud_id')->primary();
            $table->unsignedBigInteger('player_id')->index();
            $table->unsignedBigInteger('related_player_id')->index();
            $table->string('type', 20)->index();
            $table->timestamp('cloud_updated_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mirror_player_relationships');
        Schema::dropIfExists('mirror_game_entities');
        Schema::dropIfExists('mirror_players');
    }
};
