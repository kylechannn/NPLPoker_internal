<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Player-created private cash tables, mirrored at table grain so the desk
 * can tell a member's gathering table from a house one. The fields are
 * denormalised onto every seat row (the mirror is seat-grained).
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
                $table->string('table_kind', 10)->nullable();
                $table->string('creator_npl_id', 32)->nullable();
                $table->string('creator_display_name', 120)->nullable();
                $table->string('game_mode', 60)->nullable();
                $table->string('blinds_text', 60)->nullable();
                $table->boolean('allow_strangers')->nullable();
                $table->timestamp('activation_deadline_at')->nullable();
                $table->timestamp('activated_at')->nullable();
            });
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $table) {
            Schema::table($table, function (Blueprint $table): void {
                $table->dropColumn([
                    'table_kind',
                    'creator_npl_id',
                    'creator_display_name',
                    'game_mode',
                    'blinds_text',
                    'allow_strangers',
                    'activation_deadline_at',
                    'activated_at',
                ]);
            });
        }
    }
};
