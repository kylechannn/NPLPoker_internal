// Matches PublicCashTableService::GAME_TYPES / BLINDS in the cloud backend.
// The cloud validates every submitted selection; these are the public table menus.
export const CASH_TABLE_GAME_TYPES = [
  "No Limit Texas Hold'em", "PLO4 (Pot Limit Omaha)", "PLO5/6 (Pot Limit Omaha)",
  "Manila", "Bomb Pot", "5 Card Draw Poker", "Crazy Pineapple", "Scoop", "Dealers Choice",
] as const

export const CASH_TABLE_BLINDS = [
  "50c/$1 Min $30 Max $100", "$1/$1 Min $50 Max $200", "$1/$2 Min $100 Max $500",
  "$2/$5 Min $200 Max $1000", "$5/$10 Min $500 Max $2000", "$10/$20 Min $1000 Max $4000",
] as const
