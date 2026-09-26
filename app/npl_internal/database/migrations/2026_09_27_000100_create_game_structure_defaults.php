<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The game structure defaults this desk opens every game from — the super
 * admin's base setup, pulled from the NPL cloud (one row per desk kind:
 * 'tournament' with its blind ladder, 'cash' without). Nobody edits these
 * at the desk: the Game Structure tab writes to the cloud, and every
 * install mirrors the answer here so a night still opens offline.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('game_structure_defaults', function (Blueprint $table): void {
            $table->id();
            $table->string('game_type', 16)->unique();
            $table->json('settings');
            $table->json('levels')->nullable();
            // The cloud's own stamp of the save, and who made it.
            $table->string('cloud_updated_at', 40)->nullable();
            $table->string('updated_by_name', 120)->nullable();
            $table->timestamp('pulled_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('game_structure_defaults');
    }
};
