<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Local mirror of the cloud's wheel composition (Jackpot Control). Pulled on
 * every Manual update, so new prizes and odds reach the desk wheel the same
 * way venues and players do.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mirror_wheel_prizes', function (Blueprint $table) {
            $table->unsignedBigInteger('cloud_id')->primary();
            $table->string('label', 200);
            $table->string('line_one', 20);
            $table->string('line_two', 20);
            $table->string('hue', 16);
            $table->unsignedSmallInteger('weight');
            $table->unsignedSmallInteger('sort_order')->index();
            $table->string('benefit_type', 20);
            $table->string('voucher_type', 40)->nullable();
            $table->unsignedInteger('points_amount')->nullable();
            $table->timestamp('cloud_updated_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mirror_wheel_prizes');
    }
};
