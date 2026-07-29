<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Sync\OutboxService;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * The desk: what happens when a player walks up and their card is scanned.
 *
 * One scan has to answer everything the operator needs in a single glance —
 * who this is, whether they are already in the field, what they may do right
 * now, and what each of those costs. EdgeHost's registration input only ever
 * did one thing (seat them); here the same input drives buy-in, rebuy,
 * add-on and jackpot entry, because the operator does not know which one the
 * player wants until they have looked them up.
 *
 * Nothing is charged by scanning. The scan returns options; the operator
 * picks one. That separation matters at a live desk, where a scan happens by
 * accident far more often than a payment does.
 */
final class TournamentDeskService
{
    public function __construct(
        private readonly TournamentClockService $clock,
        private readonly TournamentGateService $gates,
        private readonly TournamentService $tournaments,
        private readonly TournamentBroadcaster $broadcaster,
        private readonly OutboxService $outbox,
    ) {}

    /**
     * Look a player up for this tournament and report what the desk may do.
     *
     * @return array{
     *   player: array<string, mixed>,
     *   entry: ?array<string, mixed>,
     *   options: list<array<string, mixed>>,
     *   gates: array<string, mixed>
     * }
     */
    public function scan(int $sessionId, string $rawId): array
    {
        $nplId = $this->normaliseId($rawId);

        if ($nplId === '') {
            throw ValidationException::withMessages(['player_npl_id' => ['Scan or type an NPL ID.']]);
        }

        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);

        // One box, two identifier spaces: NL####### card scans and typed
        // NPL IDs. The cloud roster is the authority — the mirror only
        // answers first because it is faster, and a miss goes straight to
        // the cloud (a player who registered a minute ago must scan clean).
        $player = $this->resolvePlayer($nplId);

        if ($player === null) {
            throw ValidationException::withMessages([
                'player_npl_id' => [sprintf(
                    'No player found for %s — card number or NPL ID. If they registered seconds ago, scan again.',
                    $nplId,
                )],
            ]);
        }

        // Everything downstream keys on the NPL ID, whichever was scanned.
        $nplId = (string) $player->npl_id;

        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        $registered = $entry !== null;
        $gates = $this->gates->gates($sessionId, $session, $state);

        return [
            'player' => [
                'npl_id' => $nplId,
                'display_name' => $player->display_name ?? $player->npl_id,
                'avatar_url' => $player->avatar_url ?? null,
                'state_code' => $player->state_code ?? null,
            ],
            'entry' => $registered ? $this->presentEntry($entry, $sessionId, $session) : null,
            'booking' => $this->onlineBooking($session, $nplId),
            'options' => $this->optionsFor($sessionId, $session, $state, $nplId, $registered, $entry),
            'gates' => $gates,
        ];
    }

    /**
     * The player's online booking for this session, from the live-synced
     * cloud mirror. An online registration is only a booking — the desk
     * confirms it at buy-in — but the operator must see it on scan: the
     * player expects the seat they picked.
     *
     * @return array{table_number: int, seat_number: int|null, status: string|null, waitlist_position: int|null}|null
     */
    private function onlineBooking(object $session, string $nplId): ?array
    {
        if ($session->game_session_id === null) {
            return null;
        }

        $booking = DB::table('mirror_session_tables')
            ->where('session_id', $session->game_session_id)
            ->where('player_npl_id', $nplId)
            ->whereIn('registration_status', ['registered', 'waitlisted'])
            ->first();

        if ($booking === null) {
            return null;
        }

        return [
            'table_number' => (int) $booking->table_number,
            'seat_number' => $booking->seat_number !== null ? (int) $booking->seat_number : null,
            'status' => $booking->registration_status,
            'waitlist_position' => $booking->waitlist_position !== null ? (int) $booking->waitlist_position : null,
        ];
    }

    /**
     * What the desk may charge this player right now, each with its price so
     * the operator never has to remember the night's numbers.
     *
     * Blocked options are returned too, with the reason — telling the
     * operator "add-ons closed at level 9" is far more use than hiding the
     * button and leaving them to wonder.
     *
     * @return list<array{action:string,label:string,price_cents:int,chips:int,allowed:bool,reason:?string}>
     */
    private function optionsFor(
        int $sessionId,
        object $session,
        array $state,
        string $nplId,
        bool $registered,
        ?object $entry,
    ): array {
        $options = [];

        $options[] = $this->option(
            'buy_in',
            'Buy-in',
            (int) $session->buy_in_price_cents,
            (int) $session->starting_stack,
            $this->gates->check($sessionId, 'buy_in', $registered, $session, $state),
        );

        $rebuyCheck = $this->gates->check($sessionId, 'rebuy', $registered, $session, $state);
        if ($rebuyCheck['allowed'] && $registered) {
            $rebuyCheck = $this->capCheck(
                $sessionId,
                $nplId,
                'rebuy',
                (int) $session->max_rebuys_per_player,
                'rebuy',
            );
        }
        $options[] = $this->option('rebuy', 'Rebuy', (int) $session->rebuy_price_cents, (int) $session->rebuy_chips, $rebuyCheck);

        $addonCheck = $this->gates->check($sessionId, 'addon', $registered, $session, $state);
        if ($addonCheck['allowed'] && $registered) {
            $addonCheck = $this->capCheck(
                $sessionId,
                $nplId,
                'addon',
                (int) $session->max_addons_per_player,
                'add-on',
            );
        }
        // One option per tier: the operator taps the amount the player is
        // holding out, no mental price list required.
        $tiers = TournamentService::addonTiers($session);
        if ($tiers === []) {
            $options[] = $this->option('addon', 'Add-on', (int) $session->addon_price_cents, (int) $session->addon_chips, $addonCheck);
        } else {
            foreach ($tiers as $index => $tier) {
                $label = count($tiers) > 1
                    ? sprintf('Add-on %s', number_format($tier['chips']))
                    : 'Add-on';
                $options[] = $this->option('addon', $label, $tier['price_cents'], $tier['chips'], $addonCheck)
                    + ['tier' => $index];
            }
        }

        if ((bool) $session->jackpot_enabled) {
            $jackpotCheck = $this->gates->check($sessionId, 'jackpot', $registered, $session, $state);

            if ($jackpotCheck['allowed'] && $entry !== null && (bool) $entry->in_jackpot) {
                $jackpotCheck = ['allowed' => false, 'reason' => 'Already in the jackpot.'];
            }

            $options[] = $this->option(
                'jackpot',
                'Join jackpot',
                (int) $session->jackpot_price_cents,
                0,
                $jackpotCheck,
            );
        }

        return $options;
    }

    /** @param  array{allowed:bool,reason:?string}  $check */
    private function option(string $action, string $label, int $priceCents, int $chips, array $check): array
    {
        return [
            'action' => $action,
            'label' => $label,
            'price_cents' => $priceCents,
            'chips' => $chips,
            'allowed' => $check['allowed'],
            'reason' => $check['reason'],
        ];
    }

    /** @return array{allowed:bool,reason:?string} */
    private function capCheck(int $sessionId, string $nplId, string $action, int $cap, string $noun): array
    {
        if ($cap <= 0) {
            return ['allowed' => true, 'reason' => null];
        }

        $used = $this->usedCount($sessionId, $nplId, $action);

        return $used >= $cap
            ? ['allowed' => false, 'reason' => sprintf('All %d %ss used.', $cap, $noun)]
            : ['allowed' => true, 'reason' => null];
    }

    private function usedCount(int $sessionId, string $nplId, string $action): int
    {
        $taken = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->where('action', $action)
            ->count();

        $voided = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->where('action', $action.'_void')
            ->count();

        return max(0, $taken - $voided);
    }

    /**
     * Apply one desk action. The gate is re-checked here rather than trusted
     * from the scan, because a level can roll between the scan and the tap.
     */
    public function apply(int $sessionId, string $rawId, string $action, array $options = []): array
    {
        $nplId = $this->normaliseId($rawId);
        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);

        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        $check = $this->gates->check($sessionId, $action, $entry !== null, $session, $state);

        if (! $check['allowed']) {
            throw ValidationException::withMessages(['action' => [$check['reason'] ?? 'That action is not available.']]);
        }

        $result = match ($action) {
            'buy_in' => $this->buyIn($sessionId, $nplId, $options),
            'rebuy' => $this->rebuy($sessionId, $nplId, $options),
            'addon' => $this->tournaments->act($sessionId, $nplId, 'addon', $options),
            'jackpot' => $this->joinJackpot($sessionId, $session, $nplId, $state),
            default => throw ValidationException::withMessages(['action' => ["Unsupported desk action [{$action}]."]]),
        };

        $this->broadcaster->publish($sessionId);

        // A paid buy-in is the venue confirming (or creating) the cloud
        // registration — online bookings are only bookings until this
        // happens, and walk-ins must appear online too.
        if ($action === 'buy_in' && $session->game_session_id !== null) {
            $this->outbox->enqueue('session_checkin', 'create', [
                'reference' => (string) Str::uuid(),
                'game_session_id' => (int) $session->game_session_id,
                'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
                'player_npl_id' => $nplId,
                'table_number' => isset($options['table_number']) ? (int) $options['table_number'] : null,
                'seat_number' => isset($options['seat_number']) ? (int) $options['seat_number'] : null,
                'entered_at' => now()->toIso8601String(),
            ]);
            $this->drainSoon();
        }

        return $result;
    }

    private function buyIn(int $sessionId, string $nplId, array $options): array
    {
        $player = DB::table('mirror_players')->where('npl_id', $nplId)->first();

        // The entry was covered by a cloud-redeemed voucher: book it at zero
        // and keep the code on the action for the audit trail.
        $voucherCode = isset($options['voucher_code']) && $options['voucher_code'] !== ''
            ? (string) $options['voucher_code']
            : null;

        return $this->tournaments->register(
            $sessionId,
            $nplId,
            $player->display_name ?? null,
            isset($options['table_number']) ? (int) $options['table_number'] : null,
            isset($options['seat_number']) ? (int) $options['seat_number'] : null,
            $voucherCode !== null
                ? ['price_cents' => 0, 'meta' => ['voucher_code' => $voucherCode]]
                : [],
        );
    }

    /** Shared card-or-NPL-ID resolution — see PlayerResolver. */
    private function resolvePlayer(string $id): ?object
    {
        return app(\App\Services\Players\PlayerResolver::class)->resolve($id);
    }

    /**
     * Push the outbox after the response is sent. Instant when online,
     * silently deferred to the 15-second scheduled sweep when not — the
     * desk response is never held up either way.
     */
    private function drainSoon(): void
    {
        $outbox = $this->outbox;
        App::terminating(function () use ($outbox): void {
            try {
                $outbox->drain();
            } catch (Throwable) {
                // Already queued locally; the scheduled drain retries.
            }
        });
    }

    /**
     * A rebuy also brings an eliminated player back to the table — that is
     * what a rebuy means, and the desk should not have to reinstate them as
     * a second step.
     */
    private function rebuy(int $sessionId, string $nplId, array $options): array
    {
        $result = $this->tournaments->act($sessionId, $nplId, 'rebuy', $options);

        DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->update([
                'status' => 'active',
                'eliminated_at' => null,
                'finish_position' => null,
                'updated_at' => now(),
            ]);

        return $result;
    }

    /**
     * Jackpot entry. Recorded locally, then queued for the cloud so the
     * running total is the same number the phone apps show — the venue desk
     * is the only place it can be collected, but it must not be the only
     * place it is known.
     */
    private function joinJackpot(int $sessionId, object $session, string $nplId, array $state): array
    {
        if (! (bool) $session->jackpot_enabled) {
            throw ValidationException::withMessages(['action' => ['The jackpot is not running for this tournament.']]);
        }

        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        if ($entry !== null && (bool) $entry->in_jackpot) {
            throw ValidationException::withMessages(['action' => ['This player is already in the jackpot.']]);
        }

        $amount = (int) $session->jackpot_price_cents;
        $reference = (string) Str::uuid();

        DB::transaction(function () use ($sessionId, $nplId, $amount, $state, $reference): void {
            DB::table('tournament_actions')->insert([
                'tournament_session_id' => $sessionId,
                'player_npl_id' => $nplId,
                'action' => 'jackpot',
                'chips' => 0,
                'price_cents' => $amount,
                'level_index' => $state['level_index'],
                'idempotency_key' => $reference,
                'meta' => json_encode(['reference' => $reference]),
                'created_at' => now(),
                'updated_at' => now(),
            ]);

            DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->update(['in_jackpot' => true, 'updated_at' => now()]);
        }, 3);

        // Queued, not posted inline: the desk must keep working through a
        // dropped internet connection, and the outbox retries on its own.
        $this->outbox->enqueue('jackpot_entry', 'create', [
            'reference' => $reference,
            'tournament_uid' => $session->uuid,
            'game_session_id' => $session->game_session_id,
            'venue_id' => $session->venue_id,
            'player_npl_id' => $nplId,
            'amount_cents' => $amount,
            'entered_at' => now()->toIso8601String(),
        ]);

        // Drain immediately: the wheel refuses to spin until the cloud knows
        // about the entry, and the player may walk straight over.
        $this->drainSoon();

        return [
            'jackpot' => [
                'joined' => true,
                'amount_cents' => $amount,
                'reference' => $reference,
            ],
        ];
    }

    /**
     * Bust a player out. They leave the seating map immediately but stay in
     * the record with their finishing position — which is the number the
     * league actually cares about.
     */
    public function eliminate(int $sessionId, string $rawId, array $options = []): array
    {
        $nplId = $this->normaliseId($rawId);
        $state = $this->clock->state($sessionId);

        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->first();

        if ($entry === null) {
            throw ValidationException::withMessages(['player_npl_id' => ['That player is not in this tournament.']]);
        }

        if ($entry->status === 'eliminated') {
            throw ValidationException::withMessages(['player_npl_id' => ['That player is already out.']]);
        }

        DB::transaction(function () use ($sessionId, $nplId, $state, $options): void {
            // Finishing position counts down from the field size: the first
            // player out finishes last.
            $stillIn = DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('status', 'active')
                ->count();

            DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->update([
                    'status' => 'eliminated',
                    'eliminated_at' => now(),
                    'finish_position' => $stillIn,
                    // The seat is freed the moment they bust so the desk can
                    // rebalance tables without a second step.
                    'table_number' => null,
                    'seat_number' => null,
                    'updated_at' => now(),
                ]);

            DB::table('tournament_actions')->insert([
                'tournament_session_id' => $sessionId,
                'player_npl_id' => $nplId,
                'action' => 'ko',
                'chips' => 0,
                'price_cents' => 0,
                'level_index' => $state['level_index'],
                'idempotency_key' => $options['idempotency_key'] ?? null,
                'meta' => json_encode([
                    'finish_position' => $stillIn,
                    'knocked_out_by' => $options['knocked_out_by'] ?? null,
                ]),
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }, 3);

        $this->broadcaster->publish($sessionId);

        // A busted player must leave the public seat map too, or phones and
        // the website keep showing them seated until the session ends.
        $this->pushSeatToCloud($this->clock->session($sessionId), $nplId, null, null);

        return $this->seating($sessionId);
    }

    /** Undo a bust — the desk mis-clicks, and the ledger should show that. */
    public function reinstate(int $sessionId, string $rawId): array
    {
        $nplId = $this->normaliseId($rawId);
        $state = $this->clock->state($sessionId);

        DB::transaction(function () use ($sessionId, $nplId, $state): void {
            DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->update([
                    'status' => 'active',
                    'eliminated_at' => null,
                    'finish_position' => null,
                    'updated_at' => now(),
                ]);

            DB::table('tournament_actions')->insert([
                'tournament_session_id' => $sessionId,
                'player_npl_id' => $nplId,
                'action' => 'unko',
                'chips' => 0,
                'price_cents' => 0,
                'level_index' => $state['level_index'],
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }, 3);

        $this->broadcaster->publish($sessionId);

        return $this->seating($sessionId);
    }

    /** Move a player to a seat, or off the table into the unseated pool. */
    public function seat(int $sessionId, string $rawId, ?int $tableNumber, ?int $seatNumber): array
    {
        $nplId = $this->normaliseId($rawId);
        $session = $this->clock->session($sessionId);
        $perTable = max(1, (int) $session->seats_per_table);

        if ($seatNumber !== null && ($seatNumber < 1 || $seatNumber > $perTable)) {
            throw ValidationException::withMessages([
                'seat_number' => [sprintf('Seats run 1 to %d at this tournament.', $perTable)],
            ]);
        }

        if ($tableNumber !== null && $seatNumber !== null) {
            $taken = DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('table_number', $tableNumber)
                ->where('seat_number', $seatNumber)
                ->where('status', 'active')
                ->where('player_npl_id', '!=', $nplId)
                ->exists();

            if ($taken) {
                throw ValidationException::withMessages([
                    'seat_number' => [sprintf('Table %d seat %d is taken.', $tableNumber, $seatNumber)],
                ]);
            }
        }

        DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('player_npl_id', $nplId)
            ->update([
                'table_number' => $tableNumber,
                'seat_number' => $seatNumber,
                'updated_at' => now(),
            ]);

        // Mirror the move to the cloud seat map immediately — desk wins
        // there, and phones/website follow within seconds. A null table is
        // a stand-up and must sync too, or the public map keeps showing a
        // player who left the seat.
        $this->pushSeatToCloud($this->clock->session($sessionId), $nplId, $tableNumber, $seatNumber);

        return $this->seating($sessionId);
    }

    /** Queue a cloud seat update (or unseat, when table is null) and push now. */
    private function pushSeatToCloud(object $session, string $nplId, ?int $tableNumber, ?int $seatNumber): void
    {
        if ($session->game_session_id === null) {
            return;
        }

        $this->outbox->enqueue('session_seat_change', 'update', [
            'game_session_id' => (int) $session->game_session_id,
            'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
            'player_npl_id' => $nplId,
            'table_number' => $tableNumber,
            'seat_number' => $seatNumber,
            'moved_at' => now()->toIso8601String(),
            // Repeating an identical move (A→B, A→C, back to A→B) must be a
            // fresh outbox entry, not a content-hash hit on the sent one.
            'nonce' => (string) Str::uuid(),
        ]);
        $this->drainSoon();
    }

    /**
     * The seating map the desk works from: active players only, arranged in
     * tables of `seats_per_table`, plus everyone waiting to be seated and
     * everyone already out.
     */
    public function seating(int $sessionId): array
    {
        $session = $this->clock->session($sessionId);
        $state = $this->clock->state($sessionId);
        $perTable = max(1, (int) $session->seats_per_table);

        $entries = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->orderBy('table_number')
            ->orderBy('seat_number')
            ->get();

        $active = $entries->where('status', 'active');
        $seated = $active->filter(fn (object $row): bool => $row->table_number !== null && $row->seat_number !== null);

        $highestTable = (int) ($seated->max('table_number') ?? 0);

        // The cloud's table list is the layout authority for a linked
        // session — the same tables the website seats into, kept live by
        // the realtime pull. Local head-count math only decides the layout
        // for unlinked (ad-hoc) tournaments.
        $cloudTableCount = 0;
        if ($session->game_session_id !== null) {
            $cloudTableCount = (int) DB::table('mirror_session_tables')
                ->where('session_id', $session->game_session_id)
                ->where(fn ($query) => $query->whereNull('table_status')->orWhere('table_status', '!=', 'cancelled'))
                ->max('table_number');
        }

        $tableCount = $cloudTableCount > 0
            ? max($cloudTableCount, $highestTable)
            : max($highestTable, (int) ceil(max(1, $active->count()) / $perTable));

        $tables = [];
        for ($number = 1; $number <= $tableCount; $number++) {
            $seats = [];

            for ($seat = 1; $seat <= $perTable; $seat++) {
                $occupant = $seated->first(
                    fn (object $row): bool => (int) $row->table_number === $number && (int) $row->seat_number === $seat,
                );

                $seats[] = [
                    'seat_number' => $seat,
                    'player' => $occupant ? $this->presentEntry($occupant, $sessionId, $session) : null,
                ];
            }

            $tables[] = [
                'table_number' => $number,
                'seats' => $seats,
                'occupied' => $seated->where('table_number', $number)->count(),
            ];
        }

        return [
            'seats_per_table' => $perTable,
            'tables' => $tables,
            'unseated' => $active
                ->filter(fn (object $row): bool => $row->table_number === null || $row->seat_number === null)
                ->values()
                ->map(fn (object $row): array => $this->presentEntry($row, $sessionId, $session))
                ->all(),
            'eliminated' => $entries
                ->where('status', 'eliminated')
                ->sortBy('finish_position')
                ->values()
                ->map(fn (object $row): array => $this->presentEntry($row, $sessionId, $session))
                ->all(),
            // The room display reads these too, so chip totals live here
            // rather than only in the heavier summary() call.
            'counts' => $this->tournaments->summary($sessionId) + [
                'entries' => $entries->count(),
                'active' => $active->count(),
                'eliminated' => $entries->where('status', 'eliminated')->count(),
                'in_jackpot' => $entries->where('in_jackpot', true)->count(),
            ],
            'gates' => $this->gates->gates($sessionId, $session, $state),
            'clock' => $state,
        ];
    }

    private function presentEntry(object $entry, int $sessionId, object $session): array
    {
        $nplId = (string) $entry->player_npl_id;

        return [
            'npl_id' => $nplId,
            'display_name' => $entry->player_name ?: $nplId,
            'status' => $entry->status,
            'table_number' => $entry->table_number !== null ? (int) $entry->table_number : null,
            'seat_number' => $entry->seat_number !== null ? (int) $entry->seat_number : null,
            'finish_position' => $entry->finish_position !== null ? (int) $entry->finish_position : null,
            'in_jackpot' => (bool) $entry->in_jackpot,
            'rebuys' => $this->usedCount($sessionId, $nplId, 'rebuy'),
            'addons' => $this->usedCount($sessionId, $nplId, 'addon'),
            'max_rebuys' => (int) $session->max_rebuys_per_player,
            'max_addons' => (int) $session->max_addons_per_player,
            'spend_cents' => (int) DB::table('tournament_actions')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->sum('price_cents'),
        ];
    }

    /** Scanners often append whitespace or a carriage return. */
    private function normaliseId(string $raw): string
    {
        return Str::upper(trim(preg_replace('/\s+/', '', $raw) ?? ''));
    }
}
