<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $name) {
            Schema::table($name, function (Blueprint $table): void {
                $table->boolean('setup_required')->nullable();
            });
            DB::table($name)->where('table_status', 'unopened')->update(['setup_required' => true]);
        }
    }

    public function down(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $name) {
            Schema::table($name, function (Blueprint $table): void {
                $table->dropColumn('setup_required');
            });
        }
    }
};
