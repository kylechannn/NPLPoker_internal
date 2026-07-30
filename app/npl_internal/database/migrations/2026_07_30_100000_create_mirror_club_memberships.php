<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('mirror_club_memberships')) {
            return;
        }

        // The club's member register, mirrored venue-scoped from the cloud
        // (full snapshot replace, like seating). The desk reads badges from
        // here; every write goes to the cloud first.
        Schema::create('mirror_club_memberships', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('cloud_id');
            $table->unsignedBigInteger('venue_id');
            $table->unsignedBigInteger('player_id')->nullable();
            $table->string('npl_id', 60);
            $table->string('display_name')->nullable();
            $table->string('club_member_code', 100);
            $table->string('status', 20)->default('active');
            $table->boolean('valid')->default(true);
            $table->date('joined_at')->nullable();
            $table->date('expires_at')->nullable();
            $table->string('notes', 2000)->nullable();
            $table->timestamps();

            $table->unique(['venue_id', 'cloud_id']);
            $table->index(['venue_id', 'npl_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mirror_club_memberships');
    }
};
