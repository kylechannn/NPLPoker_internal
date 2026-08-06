<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The venue's receipt-printing preferences: one row, edited from the OS
 * Overview tab. Auto-print is ON by default — every buy-in, rebuy,
 * add-on and jackpot entry prints silently on the venue's receipt
 * printer, whether the desk or an admin phone handled it. The header and
 * footer are the venue's own words.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('receipt_settings', function (Blueprint $table): void {
            $table->id();
            $table->boolean('enabled')->default(true);
            // Empty = the Windows default printer.
            $table->string('printer_name', 160)->nullable();
            $table->text('header_text')->nullable();
            $table->text('footer_text')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('receipt_settings');
    }
};
