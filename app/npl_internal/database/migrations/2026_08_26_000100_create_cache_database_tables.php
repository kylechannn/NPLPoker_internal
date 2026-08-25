<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The cache store's own SQLite file (the 'cache' connection): cache reads
 * and scheduler locks stop sharing the desk data file's single write
 * lock. SQLite has no CREATE DATABASE — the file must exist before the
 * connector opens it, so this migration touches it into being first.
 * The old cache/cache_locks tables in the main file simply fall idle.
 */
return new class extends Migration
{
    public function up(): void
    {
        $database = (string) config('database.connections.cache.database');

        if ($database !== ':memory:' && ! file_exists($database)) {
            touch($database);
        }

        $schema = Schema::connection('cache');

        if (! $schema->hasTable('cache')) {
            $schema->create('cache', function (Blueprint $table) {
                $table->string('key')->primary();
                $table->mediumText('value');
                $table->bigInteger('expiration')->index();
            });
        }

        if (! $schema->hasTable('cache_locks')) {
            $schema->create('cache_locks', function (Blueprint $table) {
                $table->string('key')->primary();
                $table->string('owner');
                $table->bigInteger('expiration')->index();
            });
        }
    }

    public function down(): void
    {
        Schema::connection('cache')->dropIfExists('cache');
        Schema::connection('cache')->dropIfExists('cache_locks');
    }
};
