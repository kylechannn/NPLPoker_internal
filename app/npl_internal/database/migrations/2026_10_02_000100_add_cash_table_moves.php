<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $name) {
            Schema::table($name, function (Blueprint $table): void {
                $table->unsignedBigInteger('registration_id')->nullable();
                $table->string('cash_seat_state', 20)->nullable();
                $table->unsignedInteger('cash_version')->nullable();
            });
        }
        Schema::table('tournament_entries', function (Blueprint $table): void {
            $table->unsignedBigInteger('cash_registration_id')->nullable();
            $table->unsignedInteger('cash_version')->nullable();
        });
        Schema::create('cash_table_moves', function (Blueprint $table): void {
            $table->unsignedBigInteger('id')->primary();
            $table->unsignedBigInteger('tournament_session_id')->index();
            $table->string('player_npl_id', 32);
            $table->string('status', 24);
            $table->json('payload');
            $table->text('reason')->nullable();
            $table->timestamps();
        });
        Schema::create('cash_entry_recoveries', function (Blueprint $table): void {
            $table->id();
            $table->unsignedBigInteger('tournament_session_id');
            $table->string('player_npl_id', 32);
            $table->json('entry_snapshot');
            $table->timestamps();
            $table->unique(['tournament_session_id', 'player_npl_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cash_entry_recoveries');
        Schema::dropIfExists('cash_table_moves');
        Schema::table('tournament_entries', fn (Blueprint $table) => $table->dropColumn(['cash_registration_id', 'cash_version']));
        foreach (['mirror_session_tables', 'mirror_session_tables_staging'] as $name) {
            Schema::table($name, fn (Blueprint $table) => $table->dropColumn(['registration_id', 'cash_seat_state', 'cash_version']));
        }
    }
};
