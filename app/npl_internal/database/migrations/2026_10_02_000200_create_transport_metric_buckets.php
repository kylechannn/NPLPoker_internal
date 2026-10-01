<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::connection('cache')->hasTable('transport_metric_buckets')) {
            Schema::connection('cache')->create('transport_metric_buckets', function (Blueprint $table): void {
                $table->unsignedBigInteger('minute');
                $table->string('family', 24);
                $table->primary(['minute', 'family']);
                foreach (['requests', 'attempts', 'not_modified', 'errors', 'skipped', 'response_body_bytes', 'duration_sum_ms', 'duration_max_ms',
                    'bucket_100', 'bucket_300', 'bucket_1000', 'bucket_3000', 'bucket_10000', 'bucket_inf'] as $column) {
                    $table->unsignedBigInteger($column)->default(0);
                }
            });
        }

        // Cash journals belong to the main database, not the cache connection.
        // Independent guards recover a partially applied cross-database migration.
        if (! Schema::hasIndex('cash_table_moves', 'cash_moves_status_created')) {
            Schema::table('cash_table_moves', fn (Blueprint $table) => $table->index(['status', 'created_at'], 'cash_moves_status_created'));
        }
    }

    public function down(): void
    {
        if (Schema::hasTable('cash_table_moves') && Schema::hasIndex('cash_table_moves', 'cash_moves_status_created')) {
            Schema::table('cash_table_moves', fn (Blueprint $table) => $table->dropIndex('cash_moves_status_created'));
        }
        Schema::connection('cache')->dropIfExists('transport_metric_buckets');
    }
};
