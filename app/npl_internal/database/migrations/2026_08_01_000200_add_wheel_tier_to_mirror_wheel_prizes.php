<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cloud wheel grew a second, all-golden tier and prizes now carry the
 * dollar value the jackpot pays out when they are drawn. The mirror embeds
 * both so the desk can render either wheel offline.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('mirror_wheel_prizes', function (Blueprint $table) {
            $table->string('wheel', 10)->default('normal')->index()->after('cloud_id');
            $table->unsignedInteger('value_cents')->nullable()->after('points_amount');
        });
    }

    public function down(): void
    {
        Schema::table('mirror_wheel_prizes', function (Blueprint $table) {
            $table->dropColumn(['wheel', 'value_cents']);
        });
    }
};
