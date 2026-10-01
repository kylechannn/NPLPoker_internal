<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Cloud\CloudClient;
use App\Services\Cloud\ConditionalCloudRead;
use App\Services\Cloud\LicenseKeyProvider;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/** Applies a player's accepted table change without another buy-in or ledger entry. */
final class CashTableMovePuller
{
    public function __construct(
        private readonly CloudClient $cloud,
        private readonly LicenseKeyProvider $license,
        private readonly TournamentBroadcaster $broadcaster,
    ) {}

    public function sync(int $sessionId): array
    {
        $empty = ['applied' => [], 'failed' => [], 'pending' => []];
        $identity = $this->license->identity();
        $session = DB::table('tournament_sessions')->where('id', $sessionId)->first();
        if (! $session || $session->game_type !== 'cash' || ! $session->game_session_id || ! $this->license->isActivated()) {
            return $empty;
        }
        $lock = Cache::lock('cash-table-moves:'.$sessionId, 120);
        if (! $lock->get()) {
            return $empty;
        }
        try {
            $path = '/api/v1/internal/desk-sessions/'.$session->game_session_id.'/cash-table-moves';
            $uid = $this->broadcaster->uid($sessionId);
            // 304 reuses the complete feed. It never bypasses pending local ACKs.
            $feed = app(ConditionalCloudRead::class)->get($path, ['tournament_uid' => $uid])['data'];
            $this->assertOwner($sessionId, (int) $session->game_session_id, $identity);
            $rows = $feed['data'] ?? [];
            $result = $empty;
            // Retry locally applied work even if its ACK committed remotely but
            // the response was lost and it has disappeared from the pending feed.
            $queued = DB::table('cash_table_moves')->where('tournament_session_id', $sessionId)
                ->whereIn('status', ['applied_pending', 'failed_pending'])->get();
            $moves = [];
            foreach ($queued as $row) {
                $moves[(int) $row->id] = json_decode($row->payload, true);
            }
            foreach ($rows as $row) {
                $moves[(int) $row['id']] = $row;
            }
            foreach ($moves as $move) {
                if (! is_array($move) || (int) ($move['id'] ?? 0) < 1) {
                    continue;
                }
                $this->assertOwner($sessionId, (int) $session->game_session_id, $identity);
                $journal = $this->apply($sessionId, $move);
                if ($journal->status === 'completed') {
                    continue;
                }
                $status = $journal->status === 'applied_pending' ? 'applied' : 'failed';
                try {
                    $this->assertOwner($sessionId, (int) $session->game_session_id, $identity);
                    $answer = $this->cloud->postJson($path.'/'.$move['id'].'/ack', [
                        'tournament_uid' => $uid, 'status' => $status,
                        'reason' => $journal->reason, 'local_reference' => 'cash-move:'.$move['id'],
                    ], 'cash-move:'.$move['id'].':'.$status);
                    $this->assertOwner($sessionId, (int) $session->game_session_id, $identity);
                    $ack = $answer['move'] ?? null;
                    if (! is_array($ack) || (int) ($ack['id'] ?? 0) !== (int) $move['id']
                        || ! in_array($ack['status'] ?? null, ['applied', 'failed'], true)
                        || ! isset($ack['version']) || ! is_numeric($ack['version'])
                        || (int) $ack['version'] < 0
                        || (isset($ack['local_reference']) && $ack['local_reference'] !== 'cash-move:'.$move['id'])) {
                        throw new \RuntimeException('The cloud did not confirm this cash move. The acknowledgement will be retried.');
                    }
                    $remoteStatus = $ack['status'];
                    DB::transaction(function () use ($sessionId, $move, $status, $remoteStatus, $answer): void {
                        $entry = DB::table('tournament_entries')->where('tournament_session_id', $sessionId)
                            ->where('player_npl_id', strtoupper($move['player_npl_id']))->first();
                        if ($entry) {
                            $updates = ['cash_version' => (int) ($answer['move']['version'] ?? $move['version']), 'updated_at' => now()];
                            if ($status === 'applied' && $remoteStatus === 'failed'
                                && (int) $entry->table_number === (int) $move['to_table_number']
                                && (int) $entry->seat_number === (int) $move['to_seat_number']) {
                                $updates += ['table_number' => $move['from_table_number'], 'seat_number' => $move['from_seat_number'],
                                    'cash_registration_id' => $move['from_registration_id']];
                            }
                            DB::table('tournament_entries')->where('id', $entry->id)->update($updates);
                        }
                        DB::table('cash_table_moves')->where('id', $move['id'])->update(['status' => 'completed', 'updated_at' => now()]);
                    });
                    $key = $remoteStatus === 'applied' ? 'applied' : 'failed';
                    $result[$key][] = ['id' => $move['id'], 'npl_id' => $move['player_npl_id'],
                        'table_number' => $move['to_table_number'], 'reason' => $answer['move']['reason'] ?? $journal->reason];
                } catch (\Throwable $e) {
                    $result['pending'][] = (int) $move['id'];
                    Log::info('cash table move acknowledgement pending', ['move' => $move['id'], 'error' => $e->getMessage()]);
                }
            }
            $this->assertOwner($sessionId, (int) $session->game_session_id, $identity);
            $reconciled = $this->reconcilePositions($sessionId, (int) $session->game_session_id, $feed['positions'] ?? [], array_column($moves, 'player_npl_id'));
            if ($reconciled !== []) {
                $result['reconciled'] = $reconciled;
            }
            if ($result['applied'] !== [] || $result['failed'] !== [] || $reconciled !== []) {
                rescue(fn () => $this->broadcaster->publish($sessionId), report: true);
            }
            return $result;
        } catch (\Throwable $e) {
            Log::info('cash table moves sync skipped', ['session' => $sessionId, 'error' => $e->getMessage()]);
            return $empty;
        } finally {
            $lock->release();
        }
    }

    private function assertOwner(int $sessionId, int $gameSessionId, string $identity): void
    {
        $session = DB::table('tournament_sessions')->where('id', $sessionId)->first();
        if ($this->license->identity() !== $identity || ! $session
            || (int) $session->game_session_id !== $gameSessionId || $session->game_type !== 'cash'
            || in_array($session->status, ['finished', 'cancelled'], true)) {
            throw new \RuntimeException('The desk identity or cash session changed during synchronization. Retry from the current desk.');
        }
    }

    /** A stale offline desk update must not leave the local seat different from the cloud. */
    private function reconcilePositions(int $sessionId, int $gameSessionId, array $positions, array $movingPlayers): array
    {
        $busy = array_fill_keys(array_map('strtoupper', $movingPlayers), true);
        foreach (DB::table('sync_outbox')->whereIn('entity_type', ['session_checkin', 'session_seat_change', 'session_registration_cancel'])
            ->whereIn('status', ['pending', 'sending'])->get(['payload']) as $queued) {
            $payload = json_decode($queued->payload, true) ?? [];
            if ((int) ($payload['game_session_id'] ?? 0) === $gameSessionId) {
                $busy[strtoupper($payload['player_npl_id'] ?? '')] = true;
            }
        }
        return DB::transaction(function () use ($sessionId, $positions, $busy): array {
            $changed = [];
            foreach ($positions as $position) {
                $nplId = strtoupper($position['player_npl_id'] ?? '');
                if ($nplId === '' || isset($busy[$nplId])) {
                    continue;
                }
                $entry = DB::table('tournament_entries')->where('tournament_session_id', $sessionId)
                    ->where('player_npl_id', $nplId)->first();
                if ($entry && (int) ($position['version'] ?? 0) < (int) $entry->cash_version) {
                    continue;
                }
                // Never evict a different locally seated player during recovery.
                if (isset($position['table_number'], $position['seat_number'])
                    && DB::table('tournament_entries')->where('tournament_session_id', $sessionId)->where('status', 'active')
                        ->where('table_number', $position['table_number'])->where('seat_number', $position['seat_number'])
                        ->where('player_npl_id', '!=', $nplId)->exists()) {
                    continue;
                }
                $recovery = DB::table('cash_entry_recoveries')->where('tournament_session_id', $sessionId)->where('player_npl_id', $nplId)->first();
                $physicallySeated = isset($position['table_number'], $position['seat_number']);
                $wasRestored = false;
                if ($recovery && $physicallySeated && (! $entry || $entry->status !== 'active')) {
                    $wasRestored = true;
                    $snapshot = json_decode($recovery->entry_snapshot, true);
                    if (! $entry) {
                        unset($snapshot['id']);
                        $id = DB::table('tournament_entries')->insertGetId($snapshot);
                        $entry = DB::table('tournament_entries')->where('id', $id)->first();
                    } else {
                        DB::table('tournament_entries')->where('id', $entry->id)->update([
                            'status' => 'active', 'eliminated_at' => null, 'finish_position' => null,
                        ]);
                    }
                }
                if ($recovery) {
                    DB::table('cash_entry_recoveries')->where('id', $recovery->id)->delete();
                }
                if (! $entry || (! $physicallySeated && $entry->status !== 'active')) {
                    continue;
                }
                if ($wasRestored || (int) $entry->table_number !== (int) ($position['table_number'] ?? 0)
                    || (int) $entry->seat_number !== (int) ($position['seat_number'] ?? 0)
                    || (int) $entry->cash_registration_id !== (int) ($position['current_registration_id'] ?? 0)) {
                    $changed[] = ['npl_id' => $nplId, 'table_number' => $position['table_number'] ?? null, 'seat_number' => $position['seat_number'] ?? null];
                }
                DB::table('tournament_entries')->where('id', $entry->id)->update([
                    'table_number' => $position['table_number'] ?? null, 'seat_number' => $position['seat_number'] ?? null,
                    'cash_registration_id' => $position['current_registration_id'] ?? null,
                    'cash_version' => (int) ($position['version'] ?? 0), 'updated_at' => now(),
                ]);
            }
            return $changed;
        }, 3);
    }

    private function apply(int $sessionId, array $move): object
    {
        return DB::transaction(function () use ($sessionId, $move): object {
            $existing = DB::table('cash_table_moves')->where('id', $move['id'])->first();
            if ($existing) {
                return $existing;
            }
            $nplId = strtoupper(trim($move['player_npl_id']));
            $entry = DB::table('tournament_entries')->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)->lockForUpdate()->first();
            $reason = null;
            if (! $entry || $entry->status !== 'active') {
                $reason = 'The player is no longer active at this desk.';
            } elseif ((int) $entry->table_number !== (int) $move['from_table_number']
                || (int) $entry->seat_number !== (int) $move['from_seat_number']
                || (int) $entry->cash_version > (int) $move['expected_version']) {
                $reason = 'The player has already moved. Refresh their current seat.';
            } elseif (DB::table('tournament_entries')->where('tournament_session_id', $sessionId)
                ->where('status', 'active')->where('table_number', $move['to_table_number'])
                ->where('seat_number', $move['to_seat_number'])->where('player_npl_id', '!=', $nplId)->exists()) {
                $reason = 'The destination seat is occupied at the desk.';
            }
            if ($reason === null) {
                DB::table('tournament_entries')->where('id', $entry->id)->update([
                    'table_number' => $move['to_table_number'], 'seat_number' => $move['to_seat_number'],
                    'cash_registration_id' => $move['to_registration_id'], 'cash_version' => $move['version'], 'updated_at' => now(),
                ]);
            }
            DB::table('cash_table_moves')->insert([
                'id' => $move['id'], 'tournament_session_id' => $sessionId, 'player_npl_id' => $nplId,
                'status' => $reason === null ? 'applied_pending' : 'failed_pending', 'reason' => $reason,
                'payload' => json_encode($move), 'created_at' => now(), 'updated_at' => now(),
            ]);
            return DB::table('cash_table_moves')->where('id', $move['id'])->first();
        }, 3);
    }
}
