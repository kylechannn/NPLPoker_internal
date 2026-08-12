<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Two more mirrored facts about a cloud seat/table:
 *  - pre_registered: the occupant booked online but has not checked in
 *    (or paid by voucher) yet — the desk grid wears it as a PRE tag.
 *  - rules_text: the creator's house rules on a private table, shown on
 *    the desk's hover card. Was deliberately unmirrored at first; the
 *    operator now needs the whole creation record at a glance.
 * The staging twin MUST gain the identical columns in the identical
 * order: the snapshot swap is a positional `INSERT INTO live SELECT *
 * FROM staging`.
 */
return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->boolean('pre_registered')->nullable();
                $table->string('rules_text', 500)->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->dropColumn(['pre_registered', 'rules_text']);
            });
        }
    }
};
