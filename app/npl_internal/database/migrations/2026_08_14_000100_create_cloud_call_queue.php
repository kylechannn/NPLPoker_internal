<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The generic cloud call queue: desk actions that used to WAIT on a cloud
 * round trip (remove/promote registrations, cancel tables, comments…) now
 * apply locally, enqueue here, and a background drain replays the exact
 * same cloud endpoints with retry + dead-letter. The operator never feels
 * the network.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('cloud_call_queue')) {
            return;
        }

        Schema::create('cloud_call_queue', function (Blueprint $table): void {
            $table->id();
            // FIFO scope: jobs in one group hold their order; other groups
            // keep flowing past a backed-off head (e.g. "session:123").
            $table->string('group_key', 80)->nullable();
            // Operator-readable: what this job IS, for the dead-letter list.
            $table->string('label', 160);
            $table->string('method', 8);
            $table->string('path', 300);
            $table->json('payload')->nullable();
            // Passed to the cloud as the Idempotency-Key header when set.
            $table->string('idempotency_key', 64)->nullable();
            // DELETE/remove jobs: a 404/410 answer means "already done".
            $table->boolean('tolerate_missing')->default(false);
            $table->string('status', 12)->default('pending');
            $table->unsignedInteger('attempts')->default(0);
            $table->timestamp('available_at')->nullable();
            $table->string('last_error', 500)->nullable();
            $table->timestamp('sent_at')->nullable();
            $table->timestamps();

            $table->index(['status', 'id']);
            $table->index(['group_key', 'status']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('cloud_call_queue');
    }
};
