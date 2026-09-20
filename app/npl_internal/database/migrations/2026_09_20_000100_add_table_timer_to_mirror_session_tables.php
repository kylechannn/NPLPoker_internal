<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Each cash table's own stopwatch, started and paused by the director from
 * this desk. The cloud counts; the mirror keeps its last report as elapsed
 * milliseconds plus the moment (this machine's clock, epoch ms) it was
 * heard, so the desk can keep counting between reports. The staging twin
 * MUST gain the identical columns in the identical order: the snapshot
 * swap is a positional `INSERT INTO live SELECT * FROM staging`.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->boolean('timer_running')->nullable();
                $blueprint->unsignedBigInteger('timer_elapsed_ms')->nullable();
                $blueprint->unsignedBigInteger('timer_synced_ms')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $blueprint): void {
                $blueprint->dropColumn(['timer_running', 'timer_elapsed_ms', 'timer_synced_ms']);
            });
        }
    }
};
