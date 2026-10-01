<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('mirror_players', function (Blueprint $table): void {
            $table->boolean('email_verification_required')->default(false);
            $table->boolean('can_use_vouchers')->default(true);
        });
    }

    public function down(): void
    {
        Schema::table('mirror_players', function (Blueprint $table): void {
            $table->dropColumn(['email_verification_required', 'can_use_vouchers']);
        });
    }
};
