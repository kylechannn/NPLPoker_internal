<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The arrival clock on player-created cash tables, mirrored per seat: the
 * cloud's ISO deadline (stored as text, like gather_starts_at) and the
 * checked-in flag that turns a PRE seat LIVE on the desk grid. The staging
 * twin MUST gain the identical columns in the identical order: the
 * snapshot swap is a positional `INSERT INTO live SELECT * FROM staging`.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->string('hold_expires_at', 40)->nullable();
                $blueprint->boolean('checked_in')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->dropColumn(['hold_expires_at', 'checked_in']);
            });
        }
    }
};
