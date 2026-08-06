<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The local cache of live chip counts recorded on admin phones. The CLOUD
 * owns this data (admins write it there; the desk only displays it) — the
 * service-sync poll replaces these rows wholesale, so a cloud-side clear
 * clears the desk too. No row = not counted; the seat renders clean.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('live_chip_counts', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tournament_session_id')->index();
            $table->string('player_npl_id', 32);
            $table->unsignedBigInteger('chips');
            $table->string('recorded_by', 120)->nullable();
            // The cloud's updated_at — the "counted at" moment every
            // surface shows. Kept verbatim so desk and phones agree.
            $table->string('counted_at', 40)->nullable();
            $table->timestamps();

            $table->unique(['tournament_session_id', 'player_npl_id'], 'uq_live_chip_session_player');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('live_chip_counts');
    }
};
