<?php

declare(strict_types=1);

namespace App\Services\Tournament;

/**
 * Builds a blind ladder from a pattern instead of making the desk type
 * twenty rows by hand.
 *
 * EdgeHost only offered "double each level" or "add N", applied to a single
 * opaque blind number. Poker needs a real small/big blind pair plus antes,
 * and a venue's structure is usually described exactly the way this takes
 * it: a starting level, a step (+500 or ×2.0), how long each level runs, and
 * a break every so often.
 *
 * The generated ladder is a starting point — every level stays individually
 * editable afterwards, because a real structure almost always has one or two
 * hand-tuned levels near the bubble.
 */
final class BlindStructureGenerator
{
    public const MODE_ADD = 'add';

    public const MODE_MULTIPLY = 'multiply';

    /** Blinds are rounded to something a dealer can actually make change for. */
    private const ROUNDING_STEPS = [
        1_000_000 => 100_000,
        100_000 => 10_000,
        10_000 => 1_000,
        1_000 => 100,
        100 => 25,
    ];

    /**
     * @param  array{
     *   levels?: int,
     *   duration_min?: int,
     *   small_blind?: int,
     *   big_blind_multiple?: float,
     *   mode?: string,
     *   step?: float,
     *   break_every?: int,
     *   break_duration_min?: int,
     *   ante_from_level?: ?int,
     *   ante_as_big_blind?: bool,
     * }  $options
     * @return list<array{level_no:int,type:string,small_blind:int,big_blind:int,ante:int,bb_ante:int,duration_min:int,sort_order:int,note:?string}>
     */
    public function generate(array $options = []): array
    {
        $count = $this->clamp((int) ($options['levels'] ?? 18), 1, 60);
        $duration = $this->clamp((int) ($options['duration_min'] ?? 20), 1, 180);
        $small = max(1, (int) ($options['small_blind'] ?? 100));
        $bigMultiple = max(1.0, (float) ($options['big_blind_multiple'] ?? 2.0));
        $mode = ($options['mode'] ?? self::MODE_MULTIPLY) === self::MODE_ADD
            ? self::MODE_ADD
            : self::MODE_MULTIPLY;
        $step = (float) ($options['step'] ?? ($mode === self::MODE_ADD ? 500 : 1.5));
        $breakEvery = max(0, (int) ($options['break_every'] ?? 6));
        $breakDuration = $this->clamp((int) ($options['break_duration_min'] ?? 15), 1, 120);
        $anteFrom = isset($options['ante_from_level']) && $options['ante_from_level'] !== null
            ? max(1, (int) $options['ante_from_level'])
            : null;
        $anteAsBigBlind = (bool) ($options['ante_as_big_blind'] ?? true);

        $levels = [];
        $current = $small;
        $levelNo = 0;
        $sort = 0;

        for ($i = 1; $i <= $count; $i++) {
            $levelNo++;
            $sort++;

            $big = (int) round($current * $bigMultiple);
            // The big blind ante is the modern default: one ante posted by the
            // big blind, equal to the big blind, rather than one per player.
            $bbAnte = $anteFrom !== null && $levelNo >= $anteFrom && $anteAsBigBlind ? $big : 0;
            $ante = $anteFrom !== null && $levelNo >= $anteFrom && ! $anteAsBigBlind
                ? max(1, (int) round($big / 8))
                : 0;

            $levels[] = [
                'level_no' => $levelNo,
                'type' => 'blind',
                'small_blind' => (int) $current,
                'big_blind' => $big,
                'ante' => $ante,
                'bb_ante' => $bbAnte,
                'duration_min' => $duration,
                'sort_order' => $sort,
                'note' => null,
            ];

            // A break sits between levels and does not consume a level number,
            // so "registration closes at level 6" means the same thing whether
            // or not a break happens to fall before it.
            if ($breakEvery > 0 && $i % $breakEvery === 0 && $i !== $count) {
                $sort++;
                $levels[] = [
                    'level_no' => $levelNo,
                    'type' => 'break',
                    'small_blind' => 0,
                    'big_blind' => 0,
                    'ante' => 0,
                    'bb_ante' => 0,
                    'duration_min' => $breakDuration,
                    'sort_order' => $sort,
                    'note' => 'Break',
                ];
            }

            $current = $this->round($mode === self::MODE_ADD ? $current + $step : $current * $step);
        }

        return $levels;
    }

    /**
     * A preview of what a pattern produces, for the preset screen — the desk
     * should see the ladder before committing to it.
     *
     * @return list<string>
     */
    public function describe(array $levels): array
    {
        $lines = [];

        foreach ($levels as $level) {
            if ($level['type'] === 'break') {
                $lines[] = sprintf('Break — %d min', $level['duration_min']);

                continue;
            }

            $blinds = sprintf('%s / %s', number_format($level['small_blind']), number_format($level['big_blind']));
            $ante = $level['bb_ante'] > 0
                ? sprintf(' (%s BB ante)', number_format($level['bb_ante']))
                : ($level['ante'] > 0 ? sprintf(' (%s ante)', number_format($level['ante'])) : '');

            $lines[] = sprintf('L%d — %s%s — %d min', $level['level_no'], $blinds, $ante, $level['duration_min']);
        }

        return $lines;
    }

    /** Keeps generated blinds to values a chip tray can actually pay. */
    private function round(float $value): int
    {
        $value = max(1.0, $value);

        foreach (self::ROUNDING_STEPS as $threshold => $step) {
            if ($value >= $threshold) {
                return (int) (round($value / $step) * $step);
            }
        }

        return (int) (round($value / 25) * 25) ?: 25;
    }

    private function clamp(int $value, int $min, int $max): int
    {
        return max($min, min($max, $value));
    }
}
