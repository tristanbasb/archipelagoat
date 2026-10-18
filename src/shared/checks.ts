// The checks a session aims at and how far a player may stray from them (spec §3.5): the same rules
// for the balancing proposals of the main process and for the Checks panel.
import type { BalanceTarget, PlayerChecks } from './types'

/** How far from the target a count may be before it is flagged: a quarter of the target. */
const OFF_TARGET = 0.25

/** The target as a share of the median. */
const FACTORS: Record<Exclude<BalanceTarget['kind'], 'count'>, number> = { median: 1, short: 0.6, long: 1.5 }

/**
 * The counts a target is taken from: measured or read from a generation. An estimate is the most
 * checks the game can have, not the player's count.
 */
export function measuredCounts(players: readonly PlayerChecks[]): number[] {
  return players.flatMap((player) =>
    player.checks !== null && player.source !== 'estimate' ? [player.checks] : [],
  )
}

/**
 * The number of checks `target` stands for: the median of `counts` (the middle of the two middle
 * ones for an even number of counts, 0 without any), 0.6 × or 1.5 × it, rounded; or the number asked.
 */
export function targetOf(counts: readonly number[], target: BalanceTarget): number {
  if (target.kind === 'count') return target.value
  const sorted = [...counts].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const high = sorted[middle] ?? 0
  const median = sorted.length % 2 === 1 ? high : ((sorted[middle - 1] ?? 0) + high) / 2
  return Math.round(median * FACTORS[target.kind])
}

/** True when `checks` is more than 25 % away from `target`, above or below. */
export function isOffTarget(checks: number, target: number): boolean {
  return Math.abs(checks - target) > OFF_TARGET * target
}
