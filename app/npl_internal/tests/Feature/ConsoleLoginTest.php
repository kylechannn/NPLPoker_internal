<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The operator gate signs in with the SAME admin account + password as
 * the NPL website: credentials go to the cloud's admin/auth/login, and
 * only the verified identity comes back to the console.
 */
class ConsoleLoginTest extends TestCase
{
    use RefreshDatabase;

    public function test_website_admin_credentials_open_the_console(): void
    {
        Http::fake([
            '*/api/v1/admin/auth/login' => Http::response([
                'ok' => true,
                'message' => 'Admin logged in successfully.',
                'data' => [
                    'token_type' => 'Bearer',
                    'access_token' => 'jwt-not-kept',
                    'expires_in' => 3600,
                    'admin' => [
                        'id' => 7,
                        'login' => 'kyle',
                        'email' => 'kyle@npl.local',
                        'display_name' => 'Kyle Chan',
                        'role' => 'super_admin',
                        'role_label' => 'Super Admin',
                        'status' => 'active',
                    ],
                ],
            ]),
        ]);

        $this->postJson('/api/v1/console/login', ['login' => 'Kyle', 'password' => 'Secret123!'])
            ->assertOk()
            ->assertJsonPath('data.identity.id', 'kyle')
            ->assertJsonPath('data.identity.name', 'Kyle Chan')
            ->assertJsonPath('data.identity.role', 'Super Admin')
            ->assertJsonPath('data.identity.initials', 'KC');

        // The exact website pathway: login lowercased, password verbatim.
        Http::assertSent(fn (ClientRequest $request): bool => str_contains($request->url(), '/api/v1/admin/auth/login')
            && $request['login'] === 'kyle'
            && $request['password'] === 'Secret123!');
    }

    public function test_wrong_website_credentials_read_back_the_clouds_sentence(): void
    {
        Http::fake([
            '*/api/v1/admin/auth/login' => Http::response([
                'ok' => false,
                'message' => 'The given data was invalid.',
                'errors' => ['login' => ['The provided admin credentials are invalid.']],
            ], 422),
        ]);

        $this->postJson('/api/v1/console/login', ['login' => 'kyle', 'password' => 'nope'])
            ->assertStatus(422)
            ->assertJsonPath('error.message', 'The provided admin credentials are invalid.');
    }

    public function test_no_internet_reads_as_no_internet(): void
    {
        Http::fake(fn () => throw new ConnectionException('cURL error 6'));

        $this->postJson('/api/v1/console/login', ['login' => 'kyle', 'password' => 'Secret123!'])
            ->assertStatus(422)
            ->assertJsonPath('error.message', 'Could not reach the NPL cloud — check the venue internet, then try again.');
    }
}
