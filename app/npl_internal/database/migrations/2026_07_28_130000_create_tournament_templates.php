<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Saved tournament presets, so a venue that runs the same Friday deepstack
 * every week does not rebuild the blind structure each time.
 *
 * EdgeHost had no templates: its 19-level default was hardcoded twice (once
 * in PHP, once in React) and any customisation had to be re-entered per
 * session. Here a structure is saved once, optionally marked default, and a
 * new tournament can be created straight from it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('tournament_templates', function (Blueprint $table) {
            $table->id();
            $table->string('name', 120)->unique();
            $table->string('description', 255)->nullable();
            // Exactly one template may be the default; enforced in the service.
            $table->boolean('is_default')->default(false)->index();
            $table->json('settings');
            $table->json('levels');
            $table->unsignedInteger('times_used')->default(0);
            $table->timestamp('last_used_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('tournament_templates');
    }
};
