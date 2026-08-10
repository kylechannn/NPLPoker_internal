<?php

declare(strict_types=1);

namespace App\Services\Tournament;

use App\Services\Sync\OutboxService;
use Illuminate\Support\Facades\App;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
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
        private readonly \App\Services\Printing\ReceiptService $receipts,
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

        // Everything downstream keys on the NPL ID, whichever was scanned —
        // NORMALISED, because apply() writes entries uppercased while the
        // mirror stores the player's own casing, and SQLite compares TEXT
        // case-sensitively. Keying on the mirror casing here meant an
        // online-registered "SteveP" never matched his "STEVEP" entry: the
        // scan offered only buy-in forever, and rebuy/add-on/jackpot stayed
        // locked after he bought in.
        $nplId = $this->normaliseId((string) $player->npl_id);

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

        // Mirror rows keep the cloud's mixed casing; callers pass the
        // normalised (uppercase) id — compare case-insensitively or a
        // player's booked online seat is silently ignored.
        $booking = DB::table('mirror_session_tables')
            ->where('session_id', $session->game_session_id)
            ->whereRaw('UPPER(player_npl_id) = ?', [$this->normaliseId($nplId)])
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
        $rebuyTiers = TournamentService::rebuyTiers($session);
        if ($rebuyTiers === []) {
            $options[] = $this->option('rebuy', 'Rebuy', (int) $session->rebuy_price_cents, (int) $session->rebuy_chips, $rebuyCheck);
        } else {
            foreach ($rebuyTiers as $index => $tier) {
                $label = count($rebuyTiers) > 1
                    ? sprintf('Rebuy %s', number_format($tier['chips']))
                    : 'Rebuy';
                $options[] = $this->option('rebuy', $label, $tier['price_cents'], $tier['chips'], $rebuyCheck)
                    + ['tier' => $index];
            }
        }

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

            // "Already in" beats the gate's "first buy-in only" as the
            // reason the operator sees — it answers the actual question.
            if ($entry !== null && (bool) $entry->in_jackpot) {
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

        $playerIsRegistered = $entry !== null;

        // Batch nuance: the popup fires buy_in then jackpot in ONE submit,
        // so by the time the jackpot lands the entry already exists. The
        // first_buy_in flag (sent only when the buy-in was part of the same
        // ticked batch) plus a freshness check lets that one legitimate pair
        // through; any later attempt stays shut — on cash desks and
        // tournaments alike, the jackpot is joined with the first buy-in or
        // never.
        if ($action === 'jackpot'
            && $playerIsRegistered
            && (bool) ($options['first_buy_in'] ?? false)
            && $entry->created_at !== null
            && \Illuminate\Support\Carbon::parse($entry->created_at)->gt(now()->subMinutes(5))) {
            $playerIsRegistered = false;
        }

        $check = $this->gates->check($sessionId, $action, $playerIsRegistered, $session, $state);

        if (! $check['allowed']) {
            throw ValidationException::withMessages(['action' => [$check['reason'] ?? 'That action is not available.']]);
        }

        $result = match ($action) {
            'buy_in' => $this->buyIn($sessionId, $session, $nplId, $options),
            'rebuy' => $this->rebuy($sessionId, $nplId, $options),
            'addon' => $this->tournaments->act($sessionId, $nplId, 'addon', $options),
            'jackpot' => $this->joinJackpot($sessionId, $session, $nplId, $state),
            default => throw ValidationException::withMessages(['action' => ["Unsupported desk action [{$action}]."]]),
        };

        $this->broadcaster->publish($sessionId);

        // A paid buy-in is the venue confirming (or creating) the cloud
        // registration — online bookings are only bookings until this
        // happens, and walk-ins must appear online too. The seat comes from
        // the entry row, because buy-in may have auto-assigned one.
        if ($action === 'buy_in' && $session->game_session_id !== null) {
            $entry = DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->where('player_npl_id', $nplId)
                ->first();

            $this->outbox->enqueue('session_checkin', 'create', [
                'reference' => (string) Str::uuid(),
                'game_session_id' => (int) $session->game_session_id,
                'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
                'player_npl_id' => $nplId,
                'table_number' => $entry?->table_number !== null ? (int) $entry->table_number : null,
                'seat_number' => $entry?->seat_number !== null ? (int) $entry->seat_number : null,
                'entered_at' => now()->toIso8601String(),
            ]);
            $this->drainSoon();
        }

        // The money's paper trail: every applied buy-in/rebuy/add-on/
        // jackpot prints its receipt silently — desk-scanned or
        // phone-resolved alike. A printer problem is a status, never a
        // failed sale.
        if (is_array($result)) {
            $result['receipt'] = rescue(
                fn (): string => $this->receipts->printAction($sessionId, $session, $nplId, $action, $options),
                'failed',
                false,
            );
        }

        return $result;
    }

    private function buyIn(int $sessionId, object $session, string $nplId, array $options): array
    {
        // $nplId arrives normalised (uppercase); the mirror keeps the
        // player's own casing — a case-sensitive match loses the name.
        $player = DB::table('mirror_players')->whereRaw('UPPER(npl_id) = ?', [$nplId])->first();

        // The entry was covered by a cloud-redeemed voucher: charge only what
        // the voucher's entry-fee limit leaves uncovered (no limit = free),
        // and keep the code + covered amount on the action for the audit
        // trail. The limit rides in from the cloud voucher via the UI.
        $voucherCode = isset($options['voucher_code']) && $options['voucher_code'] !== ''
            ? (string) $options['voucher_code']
            : null;

        $voucherLimit = isset($options['voucher_limit_cents']) && $options['voucher_limit_cents'] !== null
            ? max(0, (int) $options['voucher_limit_cents'])
            : null;

        // Championship stacking rides on a summed COVERED amount instead of
        // a single limit: N ticket values against the price, deficit due.
        $voucherCodes = array_values(array_filter(array_map(
            fn ($code): string => trim((string) $code),
            (array) ($options['voucher_codes'] ?? []),
        ), fn (string $code): bool => $code !== ''));

        $stackCovered = isset($options['voucher_covered_cents']) && $options['voucher_covered_cents'] !== null
            ? max(0, (int) $options['voucher_covered_cents'])
            : null;

        $buyInPrice = (int) $session->buy_in_price_cents;

        if ($stackCovered !== null) {
            $voucherPrice = max(0, $buyInPrice - $stackCovered);
            $coveredCents = min($stackCovered, $buyInPrice);
        } else {
            $voucherPrice = $voucherLimit === null ? 0 : max(0, $buyInPrice - $voucherLimit);
            $coveredCents = $buyInPrice - $voucherPrice;
        }

        $tableNumber = isset($options['table_number']) ? (int) $options['table_number'] : null;
        $seatNumber = isset($options['seat_number']) ? (int) $options['seat_number'] : null;

        // First buy-in seats the player automatically — honouring an online
        // seat pick, dodging blocked players, balancing tables. ONLY the
        // buy-in does this: rebuys and add-ons never touch a seat, the
        // player already has one.
        if ($tableNumber === null || $seatNumber === null) {
            [$tableNumber, $seatNumber] = $this->autoAssignSeat($sessionId, $session, $nplId);
        }

        $extras = [];

        if ($voucherCodes !== [] || $stackCovered !== null) {
            $extras = ['price_cents' => $voucherPrice, 'meta' => array_filter([
                'voucher_code' => $voucherCode,
                'voucher_codes' => $voucherCodes !== [] ? $voucherCodes : null,
                'voucher_covered_cents' => $coveredCents,
            ], fn ($value): bool => $value !== null)];
        } elseif ($voucherCode !== null) {
            $extras = ['price_cents' => $voucherPrice, 'meta' => ['voucher_code' => $voucherCode, 'voucher_covered_cents' => $coveredCents]];
        }

        return $this->tournaments->register(
            $sessionId,
            $nplId,
            $player->display_name ?? null,
            $tableNumber,
            $seatNumber,
            $extras,
        );
    }

    /**
     * Pick a seat the way a good floor manager would: the seat the player
     * booked online if it is still free, otherwise the emptiest table that
     * does not contain anyone who blocked them (or whom they blocked) —
     * friends are fine — falling back to a blocked table only when there is
     * nowhere else, and opening a fresh table when everything is full.
     *
     * @return array{0: ?int, 1: ?int}
     */
    private function autoAssignSeat(int $sessionId, object $session, string $nplId): array
    {
        $perTable = max(1, (int) $session->seats_per_table);

        $seated = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->where('status', 'active')
            ->whereNotNull('table_number')
            ->whereNotNull('seat_number')
            ->get(['player_npl_id', 'table_number', 'seat_number']);

        $occupied = [];
        foreach ($seated as $row) {
            $occupied[(int) $row->table_number][(int) $row->seat_number] = (string) $row->player_npl_id;
        }

        // The same table universe the seating map shows.
        $highestTable = $seated->max('table_number') ?? 0;
        $cloudTableCount = 0;
        if ($session->game_session_id !== null) {
            $cloudTableCount = (int) DB::table('mirror_session_tables')
                ->where('session_id', $session->game_session_id)
                ->where(fn ($query) => $query->whereNull('table_status')->orWhere('table_status', '!=', 'cancelled'))
                ->max('table_number');
        }
        $tableCount = max((int) $highestTable, $cloudTableCount, 1);

        // Their online pick first — the player expects the seat they chose.
        $booking = $this->onlineBooking($session, $nplId);
        if ($booking !== null
            && $booking['seat_number'] !== null
            && $booking['table_number'] >= 1
            && $booking['seat_number'] <= $perTable
            && ! isset($occupied[$booking['table_number']][$booking['seat_number']])) {
            return [$booking['table_number'], $booking['seat_number']];
        }

        // Tables holding someone in a blocked relationship with this player.
        $badTables = [];
        foreach ($this->blockedNplIds($nplId) as $blockedId) {
            foreach ($occupied as $tableNumber => $seats) {
                if (in_array($blockedId, $seats, true)) {
                    $badTables[$tableNumber] = true;
                }
            }
        }

        // Emptiest friendly table first; blocked tables only as a last
        // resort; a brand-new table before a blocked one.
        $candidates = [];
        for ($tableNumber = 1; $tableNumber <= $tableCount + 1; $tableNumber++) {
            $used = count($occupied[$tableNumber] ?? []);
            if ($used >= $perTable) {
                continue;
            }

            $candidates[] = [
                'table' => $tableNumber,
                'bad' => isset($badTables[$tableNumber]) ? 1 : 0,
                'overflow' => $tableNumber > $tableCount ? 1 : 0,
                'used' => $used,
            ];
        }

        usort($candidates, fn (array $a, array $b): int => [$a['bad'], $a['overflow'], $a['used'], $a['table']]
            <=> [$b['bad'], $b['overflow'], $b['used'], $b['table']]);

        foreach ($candidates as $candidate) {
            for ($seat = 1; $seat <= $perTable; $seat++) {
                if (! isset($occupied[$candidate['table']][$seat])) {
                    return [$candidate['table'], $seat];
                }
            }
        }

        return [null, null];
    }

    /**
     * NPL ids in a blocked relationship with this player, either direction,
     * resolved through the synced relationship mirror.
     *
     * @return list<string>
     */
    private function blockedNplIds(string $nplId): array
    {
        $playerId = DB::table('mirror_players')->whereRaw('UPPER(npl_id) = ?', [Str::upper($nplId)])->value('cloud_id');

        if ($playerId === null) {
            return [];
        }

        $otherIds = DB::table('mirror_player_relationships')
            ->where('type', 'blocked')
            ->where(fn ($query) => $query->where('player_id', $playerId)->orWhere('related_player_id', $playerId))
            ->get(['player_id', 'related_player_id'])
            ->flatMap(fn (object $row): array => [(int) $row->player_id, (int) $row->related_player_id])
            ->filter(fn (int $id): bool => $id !== (int) $playerId)
            ->unique()
            ->values();

        if ($otherIds->isEmpty()) {
            return [];
        }

        return DB::table('mirror_players')
            ->whereIn('cloud_id', $otherIds)
            ->pluck('npl_id')
            ->filter()
            ->map(fn ($id): string => (string) $id)
            ->values()
            ->all();
    }

    /** Shared card-or-NPL-ID resolution — see PlayerResolver. */
    private function resolvePlayer(string $id): ?object
    {
        return app(\App\Services\Players\PlayerResolver::class)->resolve($id);
    }

    /**
     * The end of the night: record the top placements, finish the clock,
     * push the standings to the cloud and WAIT for the push — the operator
     * asked to finish and expects to see it land. Offline, the standings
     * queue and the response says so honestly.
     *
     * @param  list<array{npl_id: string, position: int}>  $placements
     * @return array{finished: bool, pushed: bool, queued: bool, name: string, venue_name: ?string, recorded: int}
     */
    public function finishWithResults(int $sessionId, array $placements): array
    {
        $session = $this->clock->session($sessionId);

        $recorded = 0;

        DB::transaction(function () use ($sessionId, $placements, &$recorded): void {
            foreach ($placements as $placement) {
                $nplId = $this->normaliseId((string) $placement['npl_id']);
                $position = (int) $placement['position'];

                $updated = DB::table('tournament_entries')
                    ->where('tournament_session_id', $sessionId)
                    ->whereRaw('UPPER(player_npl_id) = ?', [$nplId])
                    ->update([
                        'finish_position' => $position,
                        'status' => 'eliminated',
                        'eliminated_at' => now(),
                        'table_number' => null,
                        'seat_number' => null,
                        'updated_at' => now(),
                    ]);

                $recorded += $updated;
            }
        }, 3);

        $this->clock->finish($sessionId);
        $this->broadcaster->publish($sessionId);

        $pushed = false;
        $queued = false;

        // An empty placement list (cash game) still pushes: the cloud marks
        // the session completed without writing any game records.
        if ($session->game_session_id !== null && ($recorded > 0 || $placements === [])) {
            $fieldSize = (int) DB::table('tournament_entries')
                ->where('tournament_session_id', $sessionId)
                ->count();

            $key = $this->outbox->enqueue('session_result', 'create', [
                'reference' => (string) Str::uuid(),
                'game_session_id' => (int) $session->game_session_id,
                'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
                'played_on' => now()->toDateString(),
                'field_size' => $fieldSize,
                'placements' => array_map(fn (array $placement): array => [
                    'npl_id' => $this->normaliseId((string) $placement['npl_id']),
                    'position' => (int) $placement['position'],
                    'rebuys' => $this->usedCount($sessionId, $this->normaliseId((string) $placement['npl_id']), 'rebuy'),
                    'addons' => $this->usedCount($sessionId, $this->normaliseId((string) $placement['npl_id']), 'addon'),
                ], $placements),
            ]);

            // Synchronous on purpose: the operator pressed Finish and is
            // watching a spinner. One drain, then the truth.
            $this->outbox->drain();

            $status = DB::table('sync_outbox')->where('idempotency_key', $key)->value('status');
            $pushed = $status === 'sent';
            $queued = ! $pushed;
        }

        // The book of record: EVERY finished session — cash included, linked
        // to a cloud game session or not — pushes its financial summary and
        // the full attendance sheet. The Export tab reads these back from
        // the cloud, so a reinstalled laptop loses nothing.
        $this->outbox->enqueue('session_report', 'create', $this->buildSessionReport($sessionId, $session));
        $this->outbox->drain();

        return [
            'finished' => true,
            'pushed' => $pushed,
            'queued' => $queued,
            'name' => (string) $session->name,
            'venue_name' => $session->venue_name !== null ? (string) $session->venue_name : null,
            'recorded' => $recorded,
        ];
    }

    /**
     * One finished session's summary + attendance, built from the local
     * money ledger (tournament_actions is the truth for amounts).
     */
    private function buildSessionReport(int $sessionId, object $session): array
    {
        $entries = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->get();

        $actions = DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->whereIn('action', ['buy_in', 'rebuy', 'addon', 'jackpot'])
            ->get()
            ->groupBy('player_npl_id');

        $attendance = [];
        $totals = ['buy_in' => 0, 'rebuy' => 0, 'addon' => 0, 'jackpot' => 0];
        $counts = ['buy_in' => 0, 'rebuy' => 0, 'addon' => 0, 'jackpot' => 0];

        foreach ($entries as $entry) {
            $mine = $actions->get($entry->player_npl_id) ?? collect();
            $paid = 0;
            $byAction = ['buy_in' => 0, 'rebuy' => 0, 'addon' => 0, 'jackpot' => 0];

            foreach ($mine as $action) {
                $paid += max(0, (int) $action->price_cents);
                $byAction[$action->action] = ($byAction[$action->action] ?? 0) + 1;
                $totals[$action->action] = ($totals[$action->action] ?? 0) + max(0, (int) $action->price_cents);
                $counts[$action->action] = ($counts[$action->action] ?? 0) + 1;
            }

            $attendance[] = [
                'npl_id' => $entry->player_npl_id,
                'display_name' => $entry->player_name,
                'buy_ins' => max(1, (int) ($byAction['buy_in'] ?? 0)),
                'rebuys' => (int) ($byAction['rebuy'] ?? 0),
                'addons' => (int) ($byAction['addon'] ?? 0),
                'in_jackpot' => (bool) $entry->in_jackpot,
                'paid_cents' => $paid,
            ];
        }

        return [
            'tournament_uid' => (string) $session->uuid,
            'game_session_id' => $session->game_session_id !== null ? (int) $session->game_session_id : null,
            'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
            'game_type' => ($session->game_type ?? 'tournament') === 'cash' ? 'cash' : 'tournament',
            'name' => (string) $session->name,
            'started_at' => $session->started_at !== null ? \Illuminate\Support\Carbon::parse($session->started_at)->toIso8601String() : null,
            'finished_at' => now()->toIso8601String(),
            'summary' => [
                'entries' => (int) $counts['buy_in'],
                'unique_players' => $entries->count(),
                'rebuys' => (int) $counts['rebuy'],
                'addons' => (int) $counts['addon'],
                'jackpot_entries' => (int) $counts['jackpot'],
                'buyin_cents' => (int) $totals['buy_in'],
                'rebuy_cents' => (int) $totals['rebuy'],
                'addon_cents' => (int) $totals['addon'],
                'jackpot_cents' => (int) $totals['jackpot'],
                'gross_cents' => (int) ($totals['buy_in'] + $totals['rebuy'] + $totals['addon'] + $totals['jackpot']),
            ],
            'attendance' => $attendance,
        ];
    }

    /**
     * Sessions still unfinished this long after they were opened (and, if
     * started, this long after Start) are retired by forceFinishStale() —
     * nobody runs a poker night this far past the doors opening.
     */
    public const STALE_AFTER_HOURS = 12;

    /**
     * The stuck-desk recovery: a session nobody pressed Finish on would hold
     * the one-session slot forever once players had bought in (discard is
     * draft-and-empty only). Twelve hours after it was opened — or after
     * Start, whichever is later — it is force-finished, players inside or
     * not.
     *
     * Deliberately NOT finishWithResults(): no session_result goes to the
     * cloud, so the cloud game session is never marked completed and any
     * laptop can still host it. The money books do survive — the attendance
     * report ships exactly as a normal Finish would.
     *
     * @return int sessions retired
     */
    public function forceFinishStale(): int
    {
        $cutoff = now()->subHours(self::STALE_AFTER_HOURS);

        $stale = DB::table('tournament_sessions')
            ->where('status', '!=', TournamentClockService::STATUS_FINISHED)
            ->where('created_at', '<=', $cutoff)
            ->where(function ($query) use ($cutoff): void {
                $query->whereNull('started_at')->orWhere('started_at', '<=', $cutoff);
            })
            ->orderBy('id')
            ->get();

        $retired = 0;

        foreach ($stale as $session) {
            try {
                $this->clock->finish((int) $session->id);
            } catch (ValidationException) {
                continue; // Finished by hand between the select and here.
            }

            // Leave a mark an operator (or a field diagnosis) can find.
            $settings = json_decode((string) ($session->settings ?? ''), true);
            $settings = is_array($settings) ? $settings : [];
            $settings['force_finished_at'] = now()->toIso8601String();

            DB::table('tournament_sessions')->where('id', $session->id)->update([
                'settings' => json_encode($settings),
                'updated_at' => now(),
            ]);

            $this->closeCloudMirror($session);

            $fresh = $this->clock->session((int) $session->id);
            $this->outbox->enqueue('session_report', 'create', $this->buildSessionReport((int) $session->id, $fresh));

            Log::warning('stale session force-finished', [
                'session' => (int) $session->id,
                'name' => (string) $session->name,
                'status_was' => (string) $session->status,
                'created_at' => (string) $session->created_at,
            ]);

            $retired++;
        }

        if ($retired > 0) {
            $this->drainSoon();
        }

        return $retired;
    }

    /**
     * Erase a session outright — the exit for "the desk set up the wrong
     * game". Unlike discardDraft this works at any status, players inside or
     * not, because the operator has explicitly confirmed the loss: entries,
     * the money ledger and the chip-count cache all go with the row.
     *
     * The cloud is told first (its live row closes under this session's uid,
     * which dies with the local row), and the cloud game session itself is
     * never touched — no report, no result — so any laptop, this one
     * included, can still create a desk session for that game.
     */
    public function eraseSession(int $sessionId): void
    {
        $session = $this->clock->session($sessionId);

        if ($session->status !== TournamentClockService::STATUS_FINISHED) {
            $this->clock->finish($sessionId);
        }

        $this->closeCloudMirror($session);

        DB::transaction(function () use ($sessionId): void {
            DB::table('live_chip_counts')->where('tournament_session_id', $sessionId)->delete();
            DB::table('tournament_actions')->where('tournament_session_id', $sessionId)->delete();
            DB::table('tournament_entries')->where('tournament_session_id', $sessionId)->delete();
            DB::table('tournament_levels')->where('tournament_session_id', $sessionId)->delete();
            DB::table('tournament_sessions')->where('id', $sessionId)->delete();
        }, 3);

        Log::warning('session erased by operator', [
            'session' => $sessionId,
            'name' => (string) $session->name,
            'status_was' => (string) $session->status,
        ]);
    }

    /**
     * Send the cloud one final state so its live row shows finished — but
     * only when this session could have broadcast at all. A blank draft
     * never published, and publishing for it here would CREATE a cloud row,
     * which the results pages would read as evidence the game was played.
     */
    private function closeCloudMirror(object $session): void
    {
        $couldHaveBroadcast = $session->started_at !== null
            || DB::table('tournament_entries')->where('tournament_session_id', (int) $session->id)->exists();

        if ($couldHaveBroadcast) {
            $this->broadcaster->publish((int) $session->id);
        }
    }

    /**
     * Kick a player out of the session entirely: the local entry goes, the
     * seat frees, and (for linked sessions) their cloud registration is
     * cancelled through the ordered outbox — same semantics as the player
     * cancelling themselves, so wait-lists promote and they get an inbox
     * notice. The money ledger keeps its rows: what was paid was paid.
     */
    public function removePlayer(int $sessionId, string $rawId): array
    {
        $nplId = $this->normaliseId($rawId);
        $session = $this->clock->session($sessionId);

        $entry = DB::table('tournament_entries')
            ->where('tournament_session_id', $sessionId)
            ->whereRaw('UPPER(player_npl_id) = ?', [$nplId])
            ->first();

        if ($entry === null) {
            throw ValidationException::withMessages(['player_npl_id' => ['That player is not in this tournament.']]);
        }

        DB::table('tournament_entries')->where('id', $entry->id)->delete();

        $this->broadcaster->publish($sessionId);

        if ($session->game_session_id !== null) {
            $this->outbox->enqueue('session_registration_cancel', 'delete', [
                'game_session_id' => (int) $session->game_session_id,
                'venue_id' => $session->venue_id !== null ? (int) $session->venue_id : null,
                'player_npl_id' => (string) $entry->player_npl_id,
                'removed_at' => now()->toIso8601String(),
                'nonce' => (string) Str::uuid(),
            ]);
            $this->drainSoon();
        }

        return $this->seating($sessionId);
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
            'game_session_id' => $session->game_session_id !== null ? (int) $session->game_session_id : null,
            'rebuy_tiers' => TournamentService::rebuyTiers($session),
            'addon_tiers' => TournamentService::addonTiers($session),
            'buy_in' => [
                'price_cents' => (int) $session->buy_in_price_cents,
                'chips' => (int) $session->starting_stack,
            ],
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
            ] + $this->countedStackSummary($sessionId),
            'gates' => $this->gates->gates($sessionId, $session, $state),
            'clock' => $state,
            // Room-display extras: chips typed at the desk, prizes owned by
            // the CLOUD game (Daily Games admin → Manual Update → here) so
            // nobody re-types a payout ladder at the desk.
            'display' => $this->displayConfig($session),
        ];
    }

    /** @return array{chip_denominations: ?string, prize_breakdown: ?array, prize_guarantee: ?string} */
    private function displayConfig(object $session): array
    {
        $settings = json_decode((string) ($session->settings ?? ''), true);
        $settings = is_array($settings) ? $settings : [];

        $denoms = trim((string) ($settings['chip_denominations'] ?? ''));
        [$rows, $guarantee, $winnerVouchers] = $this->cloudGameDisplay($session);

        return [
            'chip_denominations' => $denoms !== '' ? $denoms : null,
            'prize_breakdown' => $rows,
            'prize_guarantee' => $guarantee,
            'winner_vouchers' => $winnerVouchers,
        ];
    }

    /**
     * The payout ladder, guarantee, and winner-voucher ladder of the
     * LINKED cloud game — all authored on the admin console, mirrored on
     * Manual Update. The clock's rail shows "Guaranteed" on top, then one
     * row per place; the winner-voucher rail shows one row per configured
     * position. Null for unlinked desks or a game with nothing configured;
     * the clock simply shows nothing.
     *
     * @return array{0: ?array<int, array{place: string, prize: string}>, 1: ?string, 2: ?array<int, array{position: int, label: string}>}
     */
    private function cloudGameDisplay(object $session): array
    {
        if (empty($session->game_session_id)) {
            return [null, null, null];
        }

        $mirror = DB::table('mirror_game_sessions')
            ->where('session_id', (int) $session->game_session_id)
            ->first(['prize_breakdown', 'winner_vouchers', 'payload']);

        if ($mirror === null) {
            return [null, null, null];
        }

        $rows = json_decode((string) ($mirror->prize_breakdown ?? ''), true);
        $clean = [];

        if (is_array($rows)) {
            foreach ($rows as $row) {
                if (! is_array($row)) {
                    continue;
                }

                $clean[] = [
                    'place' => trim((string) ($row['place'] ?? '')),
                    'prize' => trim((string) ($row['prize'] ?? '')),
                ];
            }
        }

        $guarantee = null;

        if ($clean !== []) {
            // The guarantee rides in the mirrored row's full payload (the
            // cloud presenter's "guarantee" money text, e.g. "$10,000").
            $payload = json_decode((string) ($mirror->payload ?? ''), true);
            $guaranteeText = is_array($payload) ? trim((string) ($payload['guarantee'] ?? '')) : '';
            $guarantee = $guaranteeText !== '' ? $guaranteeText : null;
        }

        $winnerRows = json_decode((string) ($mirror->winner_vouchers ?? ''), true);
        $cleanWinners = [];

        if (is_array($winnerRows)) {
            foreach ($winnerRows as $row) {
                if (! is_array($row) || (int) ($row['position'] ?? 0) < 1) {
                    continue;
                }

                $label = trim((string) ($row['label'] ?? ''));

                if ($label === '') {
                    continue;
                }

                $cleanWinners[] = ['position' => (int) $row['position'], 'label' => $label];
            }
        }

        return [
            $clean !== [] ? $clean : null,
            $guarantee,
            $cleanWinners !== [] ? $cleanWinners : null,
        ];
    }

    /** Per-request cache of each venue's valid club member codes, keyed by venue then npl_id. */
    private array $clubMemberCache = [];

    /** Per-request cache of avatar URLs from the player mirror, keyed by session. */
    private array $playerAvatarCache = [];

    /** Per-request cache of admin-counted chip stacks, keyed by session. */
    private array $chipCountCache = [];

    /** Per-request cache of rebuy/addon action counts, keyed by session. */
    private array $actionCountCache = [];

    /** Per-request cache of per-player total spend, keyed by session. */
    private array $actionSpendCache = [];

    /**
     * The rail's "counted stacks" figures: how many players an admin has
     * counted and what those stacks add to. Null total when nobody has
     * been counted — the rail hides the stat instead of showing 0.
     *
     * @return array{counted_players: int, counted_chips_total: int|null}
     */
    private function countedStackSummary(int $sessionId): array
    {
        $this->liveChips($sessionId, '');
        $rows = $this->chipCountCache[$sessionId];

        return [
            'counted_players' => count($rows),
            'counted_chips_total' => $rows !== []
                ? (int) array_sum(array_map(fn (object $row): int => (int) $row->chips, $rows))
                : null,
        ];
    }

    /**
     * The admin-counted live stack for a player, or null when nobody has
     * counted them — partial coverage is the normal case, and an uncounted
     * seat must render clean rather than claim a zero.
     */
    private function liveChips(int $sessionId, string $nplId): ?object
    {
        $this->chipCountCache[$sessionId] ??= DB::table('live_chip_counts')
            ->where('tournament_session_id', $sessionId)
            ->get()
            ->keyBy(fn (object $row): string => strtoupper((string) $row->player_npl_id))
            ->all();

        return $this->chipCountCache[$sessionId][strtoupper($nplId)] ?? null;
    }

    /**
     * Whether this player holds a valid club ID for the session's venue,
     * and the code itself when they do.
     *
     * Null member state means "no data" — venue unknown, or the register
     * has never been mirrored — and the desk hides the flag rather than
     * shouting at everyone. A register with rows but no match for this
     * player is a real "no membership" (member: false, code: null), not
     * "no data".
     *
     * @return array{member: ?bool, code: ?string}
     */
    private function clubMembership(object $session, string $nplId): array
    {
        $venueId = $session->venue_id !== null ? (int) $session->venue_id : null;

        if ($venueId === null) {
            return ['member' => null, 'code' => null];
        }

        $this->clubMemberCache[$venueId] ??= DB::table('mirror_club_memberships')
            ->where('venue_id', $venueId)
            ->where('valid', true)
            ->where(fn ($query) => $query->whereNull('expires_at')->orWhere('expires_at', '>=', now()->toDateString()))
            ->pluck('club_member_code', 'npl_id')
            ->mapWithKeys(fn ($code, $id): array => [strtoupper((string) $id) => (string) $code])
            ->all();

        if ($this->clubMemberCache[$venueId] === []) {
            return ['member' => null, 'code' => null];
        }

        $code = $this->clubMemberCache[$venueId][strtoupper($nplId)] ?? null;

        return ['member' => $code !== null, 'code' => $code];
    }

    /**
     * The player mirror's avatar for one entry — batched per session on
     * first use, same reasoning as actionSummaryFor(): presentEntry() runs
     * once per roster row, so this must not be one query per player.
     */
    private function avatarFor(int $sessionId, string $nplId): ?string
    {
        $this->playerAvatarCache[$sessionId] ??= DB::table('mirror_players')
            ->whereIn('npl_id', DB::table('tournament_entries')->where('tournament_session_id', $sessionId)->pluck('player_npl_id'))
            ->whereNotNull('avatar_url')
            ->pluck('avatar_url', 'npl_id')
            ->mapWithKeys(fn ($url, $id): array => [strtoupper((string) $id) => (string) $url])
            ->all();

        return $this->playerAvatarCache[$sessionId][strtoupper($nplId)] ?? null;
    }

    /**
     * Net rebuy/addon counts and total spend for one player — two grouped
     * queries per session instead of five ungrouped ones per player.
     * presentEntry() runs once per roster row and seating() is the room
     * clock's 5-second poll, so this scaled with the field size before.
     *
     * @return array{rebuys: int, addons: int, spend_cents: int}
     */
    private function actionSummaryFor(int $sessionId, string $nplId): array
    {
        $this->actionCountCache[$sessionId] ??= DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->whereIn('action', ['rebuy', 'rebuy_void', 'addon', 'addon_void'])
            ->select('player_npl_id', 'action', DB::raw('count(*) as total'))
            ->groupBy('player_npl_id', 'action')
            ->get()
            ->groupBy(fn (object $row): string => strtoupper((string) $row->player_npl_id))
            ->map(fn ($rows) => $rows->pluck('total', 'action'))
            ->all();

        $this->actionSpendCache[$sessionId] ??= DB::table('tournament_actions')
            ->where('tournament_session_id', $sessionId)
            ->select('player_npl_id', DB::raw('sum(price_cents) as total'))
            ->groupBy('player_npl_id')
            ->get()
            ->mapWithKeys(fn (object $row): array => [strtoupper((string) $row->player_npl_id) => (int) $row->total])
            ->all();

        $key = strtoupper($nplId);
        $counts = $this->actionCountCache[$sessionId][$key] ?? collect();

        return [
            'rebuys' => max(0, (int) ($counts['rebuy'] ?? 0) - (int) ($counts['rebuy_void'] ?? 0)),
            'addons' => max(0, (int) ($counts['addon'] ?? 0) - (int) ($counts['addon_void'] ?? 0)),
            'spend_cents' => $this->actionSpendCache[$sessionId][$key] ?? 0,
        ];
    }

    private function presentEntry(object $entry, int $sessionId, object $session): array
    {
        $nplId = (string) $entry->player_npl_id;
        $chips = $this->liveChips($sessionId, $nplId);
        $actions = $this->actionSummaryFor($sessionId, $nplId);
        $club = $this->clubMembership($session, $nplId);

        return [
            'npl_id' => $nplId,
            'display_name' => $entry->player_name ?: $nplId,
            'club_member' => $club['member'],
            'club_member_code' => $club['code'],
            'avatar_url' => $this->avatarFor($sessionId, $nplId),
            'live_chips' => $chips !== null ? (int) $chips->chips : null,
            'live_chips_at' => $chips->counted_at ?? null,
            'status' => $entry->status,
            'table_number' => $entry->table_number !== null ? (int) $entry->table_number : null,
            'seat_number' => $entry->seat_number !== null ? (int) $entry->seat_number : null,
            'finish_position' => $entry->finish_position !== null ? (int) $entry->finish_position : null,
            'in_jackpot' => (bool) $entry->in_jackpot,
            'rebuys' => $actions['rebuys'],
            'addons' => $actions['addons'],
            'max_rebuys' => (int) $session->max_rebuys_per_player,
            'max_addons' => (int) $session->max_addons_per_player,
            'spend_cents' => $actions['spend_cents'],
        ];
    }

    /** Scanners often append whitespace or a carriage return. */
    private function normaliseId(string $raw): string
    {
        return Str::upper(trim(preg_replace('/\s+/', '', $raw) ?? ''));
    }
}
