<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Printing\ReceiptService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Overview tab's receipt-printing card: read and save the venue's
 * preferences (auto-print toggle, printer, the venue's own header and
 * footer wording) and fire a test receipt.
 */
final class ReceiptController extends Controller
{
    public function __construct(private readonly ReceiptService $receipts) {}

    public function settings(): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['settings' => $this->receipts->settings()]]);
    }

    public function update(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'enabled' => ['required', 'boolean'],
            'printer_name' => ['sometimes', 'nullable', 'string', 'max:160'],
            'header_text' => ['sometimes', 'nullable', 'string', 'max:2000'],
            'footer_text' => ['sometimes', 'nullable', 'string', 'max:2000'],
        ]);

        return response()->json(['ok' => true, 'data' => ['settings' => $this->receipts->update($validated)]]);
    }

    public function test(): JsonResponse
    {
        return response()->json(['ok' => true, 'data' => ['result' => $this->receipts->printTest()]]);
    }
}
