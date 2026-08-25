<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

/**
 * The resident sweeper carries the sub-minute cadences (broadcast + both
 * drains) in one long-lived process. One --once pass must run every job
 * and exit cleanly even with nothing to do — a failing job is fenced
 * inside the loop, never a crash.
 */
class OpsSweepTest extends TestCase
{
    use RefreshDatabase;

    public function test_one_pass_runs_every_job_and_exits_cleanly(): void
    {
        Http::fake(['*' => Http::response(['ok' => true, 'data' => []])]);

        $this->artisan('ops:sweep', ['--once' => true])->assertExitCode(0);
        $this->artisan('ops:sweep', ['--once' => true, '--role' => 'broadcast'])->assertExitCode(0);
        $this->artisan('ops:sweep', ['--once' => true, '--role' => 'drains'])->assertExitCode(0);
    }

    public function test_an_unknown_role_is_refused(): void
    {
        $this->artisan('ops:sweep', ['--once' => true, '--role' => 'nope'])->assertExitCode(1);
    }
}
