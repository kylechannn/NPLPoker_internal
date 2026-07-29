<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Add-ons come in tiers now — $10 for 10,000 chips, $20 for 22,000 — set
 * at preparation like everything else that costs money. The legacy single
 * addon_chips/addon_price_cents pair stays as tier one for old sessions.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table): void {
            $table->json('addon_tiers')->nullable()->after('max_addons_per_player');
        });
    }

    public function down(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table): void {
            $table->dropColumn('addon_tiers');
        });
    }
};
