<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cloud game's prize breakdown, mirrored with the session so the room
 * clock can show the payout ladder without anyone typing it at the desk.
 * The staging twin MUST gain the identical column: the snapshot swap is a
 * positional `INSERT INTO live SELECT * FROM staging`.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_game_sessions', 'mirror_game_sessions_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->json('prize_breakdown')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_game_sessions', 'mirror_game_sessions_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->dropColumn('prize_breakdown');
            });
        }
    }
};
