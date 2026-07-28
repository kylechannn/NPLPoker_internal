<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Desk controls: cut-off lines, the jackpot, and elimination.
 *
 * EdgeHost had none of these — registration stayed open forever, there was
 * no jackpot, and a busted player was only implied by a `ko` ledger row with
 * nothing removing them from the seating map.
 *
 * Cut-offs are stored as a level index rather than a wall-clock time on
 * purpose: a tournament's real timeline moves whenever the desk pauses the
 * clock, so "registration closes at the end of level 6" stays true while
 * "registration closes at 9:15pm" silently becomes wrong. The countdown the
 * players see is derived from the level index against the live clock, so it
 * follows every pause.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('tournament_sessions', function (Blueprint $table) {
            // The venue this desk is hosting for — the whole UI is scoped to it.
            $table->unsignedBigInteger('venue_id')->nullable()->index()->after('game_entity_id');

            // Cut-offs. Registration is required (the desk cannot open a
            // session without it); the other two are optional and only bite
            // when set.
            $table->unsignedSmallInteger('addon_closes_at_level')->nullable()->after('registration_closes_at_level');
            $table->unsignedSmallInteger('rebuy_closes_at_level')->nullable()->after('addon_closes_at_level');

            // Jackpot: an optional side pool a player opts into at the desk.
            $table->boolean('jackpot_enabled')->default(false)->after('rebuy_closes_at_level');
            $table->unsignedInteger('jackpot_price_cents')->default(0)->after('jackpot_enabled');
            // Null = the same cut-off as registration.
            $table->unsignedSmallInteger('jackpot_closes_at_level')->nullable()->after('jackpot_price_cents');

            $table->unsignedTinyInteger('seats_per_table')->default(8)->after('jackpot_closes_at_level');
        });

        Schema::table('tournament_entries', function (Blueprint $table) {
            // Denormalised from the ledger so the seating map is one query.
            // The ledger stays the source of truth; this is the read model.
            $table->string('status', 16)->default('active')->index()->after('player_name');
            $table->timestamp('eliminated_at')->nullable()->after('joined_at');
            // Finishing position, filled in as players bust: the last one out
            // is 2nd, and so on. Feeds the cloud result record.
            $table->unsignedSmallInteger('finish_position')->nullable()->after('eliminated_at');
            $table->boolean('in_jackpot')->default(false)->after('finish_position');
        });
    }

    public function down(): void
    {
        Schema::table('tournament_entries', function (Blueprint $table) {
            $table->dropColumn(['status', 'eliminated_at', 'finish_position', 'in_jackpot']);
        });

        Schema::table('tournament_sessions', function (Blueprint $table) {
            $table->dropColumn([
                'venue_id',
                'addon_closes_at_level',
                'rebuy_closes_at_level',
                'jackpot_enabled',
                'jackpot_price_cents',
                'jackpot_closes_at_level',
                'seats_per_table',
            ]);
        });
    }
};
