<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Desk writes always uppercased the NPL ID while the scan looked entries up
 * by the mirror's own casing — on SQLite's case-sensitive TEXT compare an
 * online-registered "SteveP" never matched his "STEVEP" entry, so the desk
 * kept offering only buy-in. The code now normalises everywhere; this
 * migration squares the rows that were written before the fix and refills
 * the display names the case miss lost.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('tournament_entries')) {
            return;
        }

        DB::table('tournament_entries')->update(['player_npl_id' => DB::raw('UPPER(player_npl_id)')]);
        DB::table('tournament_actions')->update(['player_npl_id' => DB::raw('UPPER(player_npl_id)')]);

        if (Schema::hasTable('mirror_players')) {
            DB::statement(<<<'SQL'
                UPDATE tournament_entries
                SET player_name = (
                    SELECT display_name FROM mirror_players
                    WHERE UPPER(mirror_players.npl_id) = tournament_entries.player_npl_id
                )
                WHERE player_name IS NULL
                  AND EXISTS (
                    SELECT 1 FROM mirror_players
                    WHERE UPPER(mirror_players.npl_id) = tournament_entries.player_npl_id
                  )
            SQL);
        }
    }

    public function down(): void
    {
        // Uppercasing is the canonical form — nothing to restore.
    }
};
