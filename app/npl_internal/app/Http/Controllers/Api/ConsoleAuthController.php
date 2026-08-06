<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Cloud\CloudClient;
use App\Services\Cloud\CloudException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * The OS operator gate's sign-in: the EXACT same pathway as the website's
 * admin console. Credentials go to the cloud's POST /admin/auth/login —
 * same accounts, same passwords — and only the verified identity comes
 * back to the console. The JWT is discarded: the OS's own cloud calls
 * authenticate with the CD-Key lease, not a person's session.
 */
final class ConsoleAuthController extends Controller
{
    public function __construct(private readonly CloudClient $cloud) {}

    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'login' => ['required', 'string', 'max:160'],
            'password' => ['required', 'string', 'max:128'],
        ]);

        try {
            $data = $this->cloud->postJson('/api/v1/admin/auth/login', [
                'login' => Str::lower(trim($validated['login'])),
                'password' => $validated['password'],
            ]);
        } catch (CloudException $e) {
            return response()->json([
                'ok' => false,
                'error' => ['message' => $this->friendlyMessage($e)],
            ], 422);
        }

        $admin = (array) ($data['admin'] ?? []);
        $name = trim((string) ($admin['display_name'] ?? '')) ?: (string) ($admin['login'] ?? 'Admin');

        return response()->json(['ok' => true, 'data' => ['identity' => [
            'id' => (string) ($admin['login'] ?? ''),
            'name' => $name,
            'role' => trim((string) ($admin['role_label'] ?? '')) ?: Str::title((string) ($admin['role'] ?? 'Admin')),
            'initials' => $this->initials($name),
        ]]]);
    }

    private function friendlyMessage(CloudException $e): string
    {
        if ($e->errorCode === CloudException::UNREACHABLE) {
            return 'Could not reach the NPL cloud — check the venue internet, then try again.';
        }

        // CloudClient's message reads "path failed (status): sentence" —
        // the sentence is the part the operator needs.
        $message = (string) preg_replace('/^.*failed \(\d+\): /', '', $e->getMessage());

        return $message !== '' ? $message : 'The sign-in could not be completed. Try again.';
    }

    private function initials(string $name): string
    {
        $parts = preg_split('/\s+/', trim($name)) ?: [];
        $parts = array_values(array_filter($parts, fn (string $part): bool => $part !== ''));

        if ($parts === []) {
            return 'NPL';
        }
        if (count($parts) === 1) {
            return Str::upper(Str::substr($parts[0], 0, 2));
        }

        return Str::upper(Str::substr($parts[0], 0, 1).Str::substr(end($parts), 0, 1));
    }
}
