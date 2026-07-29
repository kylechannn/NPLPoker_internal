<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The member card number (NL#######) rides the player mirror so a desk
 * scan resolves either identifier locally before falling back to the
 * cloud. Players are a delta entity — no staging twin to mirror.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasColumn('mirror_players', 'public_player_code')) {
            return;
        }

        Schema::table('mirror_players', function (Blueprint $blueprint): void {
            $blueprint->string('public_player_code', 16)->nullable()->index()->after('npl_id');
        });
    }

    public function down(): void
    {
        Schema::table('mirror_players', function (Blueprint $blueprint): void {
            $blueprint->dropColumn('public_player_code');
        });
    }
};
