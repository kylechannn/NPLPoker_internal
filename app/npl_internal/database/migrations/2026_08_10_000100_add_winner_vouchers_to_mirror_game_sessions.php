<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cloud game's winner-prize ladder, mirrored with the session so the
 * room clock can show it the same way it already shows prize_breakdown —
 * nobody types it at the desk. The ladder is per SESSION now, not per
 * venue, so it rides the session snapshot exactly like the payout ladder
 * does. The staging twin MUST gain the identical column: the snapshot
 * swap is a positional `INSERT INTO live SELECT * FROM staging`.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_game_sessions', 'mirror_game_sessions_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->json('winner_vouchers')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_game_sessions', 'mirror_game_sessions_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->dropColumn('winner_vouchers');
            });
        }
    }
};
