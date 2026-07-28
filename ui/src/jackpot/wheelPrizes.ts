// Ported verbatim from NPLPoker_frontend (src/features/jackpot/jackpotPreview.ts).
// The frontend wraps this data in a preview-fixture adapter that is a frozen
// passthrough; the wheel only ever reads `prizes` and `hueGradients`, so those
// are exported directly here.

export type WheelHue = 'electric' | 'gold' | 'cyan' | 'magenta' | 'violet' | 'green' | 'blue' | 'red'

export type WheelPrize = {
  id: string
  prize: string
  lines: [string, string]
  weight: number
  hue: WheelHue
}

export const wheelPrizes: WheelPrize[] = [
  { id: 'one-game', prize: '1 Free Game of League Poker', lines: ['1 FREE', 'GAME'], weight: 30, hue: 'electric' },
  { id: 'free-month', prize: 'Free Month of League Poker', lines: ['FREE', 'MONTH'], weight: 3, hue: 'gold' },
  { id: 'two-games', prize: '2 Free Games of League Poker', lines: ['2 FREE', 'GAMES'], weight: 21, hue: 'cyan' },
  { id: 'free-drink', prize: 'Free Drink', lines: ['FREE', 'DRINK'], weight: 3, hue: 'magenta' },
  { id: 'three-games', prize: '3 Free Games of League Poker', lines: ['3 FREE', 'GAMES'], weight: 15, hue: 'violet' },
  { id: 'day1-ticket', prize: 'Ticket into another Day 1', lines: ['DAY 1', 'TICKET'], weight: 3, hue: 'green' },
  { id: 'free-week', prize: 'Free Week of League Poker', lines: ['FREE', 'WEEK'], weight: 9, hue: 'blue' },
  { id: 'free-meal', prize: 'Free Meal', lines: ['FREE', 'MEAL'], weight: 3, hue: 'red' },
]

export const hueGradients: Record<WheelHue, [string, string]> = {
  electric: ['#3d7bff', '#081238'],
  gold: ['#ffd23d', '#3f2c04'],
  cyan: ['#00e5ff', '#03293e'],
  magenta: ['#ff2bd6', '#3c0733'],
  violet: ['#9d4dff', '#210a4a'],
  green: ['#2bffb0', '#043b27'],
  blue: ['#6a8cff', '#0e1a4e'],
  red: ['#ff4d6a', '#420f1d'],
}
