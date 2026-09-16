<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cloud's per-table phase — closed / open / scheduled / live — the
 * colour the desk grid paints each cash table, and the state the
 * director's OPEN / CLOSE / LIVE switch flips. Mirrored verbatim; the
 * cloud computes it (it folds in the session clock and the desk's own
 * per-table go-live).
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->string('table_phase', 20)->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->dropColumn('table_phase');
            });
        }
    }
};
