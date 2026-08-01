<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The staff register, mirrored from the cloud via Manual update. The QR
 * staff login resolves the typed staff ID against this table — a desk
 * never signs in a name the cloud doesn't know.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('mirror_staff', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('cloud_id')->unique();
            $table->unsignedBigInteger('venue_id')->nullable()->index();
            $table->string('staff_code', 24)->index();
            $table->string('name', 120);
            $table->string('role', 60)->default('Staff');
            $table->string('status', 20)->default('active')->index();
            $table->string('cloud_updated_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('mirror_staff');
    }
};
