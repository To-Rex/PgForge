import type { DbStats } from '@pgforge/shared'

/**
 * Client-side sample ring per (connection, database). Module-level so the
 * history survives tab switches within the session; a page reload starts
 * fresh — this is a live monitor, like top(1), not a metrics warehouse.
 */
export interface StatSample {
  t: number
  stats: DbStats
}

const MAX_SAMPLES = 120
const buffers = new Map<string, StatSample[]>()

export function pushSample(key: string, stats: DbStats): StatSample[] {
  let samples = buffers.get(key)
  if (!samples) buffers.set(key, (samples = []))
  const last = samples[samples.length - 1]
  // The query cache can hand the same payload twice; only append fresh polls.
  if (!last || last.stats !== stats) {
    samples.push({ t: Date.now(), stats })
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  }
  return samples
}

export interface RateSeries {
  times: number[]
  commitsPerSec: (number | null)[]
  rollbacksPerSec: (number | null)[]
  insertedPerSec: (number | null)[]
  updatedPerSec: (number | null)[]
  deletedPerSec: (number | null)[]
  cacheHitPct: (number | null)[]
  sessionsTotal: (number | null)[]
  sessionsActive: (number | null)[]
  sessionsIdleInTx: (number | null)[]
}

/** Converts cumulative counters into per-second rates between samples. */
export function computeRates(samples: StatSample[]): RateSeries {
  const out: RateSeries = {
    times: [],
    commitsPerSec: [],
    rollbacksPerSec: [],
    insertedPerSec: [],
    updatedPerSec: [],
    deletedPerSec: [],
    cacheHitPct: [],
    sessionsTotal: [],
    sessionsActive: [],
    sessionsIdleInTx: [],
  }
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!
    const curr = samples[i]!
    const dt = (curr.t - prev.t) / 1000
    if (dt <= 0) continue
    // Counter resets (stats_reset, restart) produce negative deltas → gap.
    const rate = (a: number, b: number): number | null => (a - b < 0 ? null : (a - b) / dt)
    out.times.push(curr.t)
    out.commitsPerSec.push(rate(curr.stats.commits, prev.stats.commits))
    out.rollbacksPerSec.push(rate(curr.stats.rollbacks, prev.stats.rollbacks))
    out.insertedPerSec.push(rate(curr.stats.tupInserted, prev.stats.tupInserted))
    out.updatedPerSec.push(rate(curr.stats.tupUpdated, prev.stats.tupUpdated))
    out.deletedPerSec.push(rate(curr.stats.tupDeleted, prev.stats.tupDeleted))
    const hitDelta = curr.stats.blksHit - prev.stats.blksHit
    const readDelta = curr.stats.blksRead - prev.stats.blksRead
    out.cacheHitPct.push(
      hitDelta < 0 || readDelta < 0 || hitDelta + readDelta === 0
        ? null
        : (hitDelta / (hitDelta + readDelta)) * 100,
    )
    out.sessionsTotal.push(curr.stats.sessionsTotal)
    out.sessionsActive.push(curr.stats.sessionsActive)
    out.sessionsIdleInTx.push(curr.stats.sessionsIdleInTx)
  }
  return out
}
