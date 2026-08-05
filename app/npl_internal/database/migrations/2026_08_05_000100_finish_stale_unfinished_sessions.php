<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * One-time normalisation for the one-session-at-a-time rule: sessions left
 * unfinished by earlier builds (field tests, abandoned drafts) are marked
 * finished — otherwise the very first create on an updated machine would be
 * refused in the name of a game nobody is playing, and the sidebar would
 * show an admin QR for it.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('tournament_sessions')
            ->where('status', '!=', 'finished')
            ->update(['status' => 'finished', 'updated_at' => now()]);
    }

    public function down(): void
    {
        // One-way: nothing records which sessions had been open.
    }
};
