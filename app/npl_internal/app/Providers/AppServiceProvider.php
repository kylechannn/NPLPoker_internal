<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        // The cache store's SQLite file must exist before the connector
        // opens it — SQLite has no CREATE DATABASE, and the connector
        // refuses a missing path outright. A fresh install (or a wiped
        // data directory) heals itself here; the cache-tables migration
        // then creates the schema.
        $cacheDb = (string) config('database.connections.cache.database');
        if ($cacheDb !== '' && $cacheDb !== ':memory:' && ! is_file($cacheDb)) {
            @touch($cacheDb);
        }
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        //
    }
}
