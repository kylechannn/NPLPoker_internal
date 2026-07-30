<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasColumn('tournament_sessions', 'game_type')) {
            return;
        }

        Schema::table('tournament_sessions', function (Blueprint $table): void {
            // 'tournament' (clocked, ranked) or 'cash' (no timer, no ranks).
            $table->string('game_type', 20)->default('tournament');
        });
    }

    public function down(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table): void {
            $table->dropColumn('game_type');
        });
    }
};
