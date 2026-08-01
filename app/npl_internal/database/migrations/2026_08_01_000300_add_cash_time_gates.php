<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Cash games get a timer after all — no blind ladder, just elapsed play —
 * and with it MINUTE-based cut-offs: registration and jackpot entry can
 * close a set number of minutes after "Start game". Blank keeps today's
 * behaviour (open until the game finishes). Tournaments keep their
 * level-index cut-offs untouched.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table) {
            $table->unsignedSmallInteger('cash_reg_close_min')->nullable()->after('jackpot_closes_at_level');
            $table->unsignedSmallInteger('cash_jackpot_close_min')->nullable()->after('cash_reg_close_min');
        });
    }

    public function down(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table) {
            $table->dropColumn(['cash_reg_close_min', 'cash_jackpot_close_min']);
        });
    }
};
