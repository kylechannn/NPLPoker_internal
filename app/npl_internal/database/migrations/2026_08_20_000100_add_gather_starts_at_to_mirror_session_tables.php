<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Private tables can carry a creator-picked time slot: the 30-minute
 * gather countdown starts THEN. Mirrored so the desk's hover card can
 * show the slot; null = the original start-at-creation behaviour.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->string('gather_starts_at', 40)->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->dropColumn('gather_starts_at');
            });
        }
    }
};
