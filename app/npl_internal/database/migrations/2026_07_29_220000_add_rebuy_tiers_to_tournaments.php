<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Rebuys get tiers like add-ons ($10/10k, $20/22k). The legacy single
 * rebuy_chips/rebuy_price_cents pair stays as tier one for old sessions.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasColumn('tournament_sessions', 'rebuy_tiers')) {
            return;
        }

        Schema::table('tournament_sessions', function (Blueprint $table): void {
            $table->json('rebuy_tiers')->nullable()->after('max_rebuys_per_player');
        });
    }

    public function down(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table): void {
            $table->dropColumn('rebuy_tiers');
        });
    }
};
