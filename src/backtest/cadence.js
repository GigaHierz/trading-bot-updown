// When does the bot actually get to look at the market?
//
// bot.yml asks for `*/30` (48 runs/day). GitHub delivers far fewer, and the
// shortfall is the single biggest difference between this strategy on paper
// and this strategy in production. A backtest that evaluates every bar is
// measuring a bot that does not exist.
//
// The quantiles below are measured from the real run history (every bot run
// commits to state/, so the commit timestamps are the run timestamps):
//
//   regime            n     mean    p50    p90    max    runs/day
//   ---------------------------------------------------------------
//   2026-08-05..      784   77.1    46.2   187.2  728.7  18.7
//   2026-08-27..      132   222.4   206.8  325.5  728.7  6.5
//
// The schedule collapsed on 2026-08-27 and has not recovered. `current` is the
// regime the bot lives in now; `historic` is the whole run for comparison.
//
// Skipped cron ticks are dropped, not deferred -- bot.yml uses
// concurrency.cancel-in-progress: false with an `if:` gate, so a missed tick
// is an information blackout, not queued work.

// [quantile, gap minutes]
const GAP_QUANTILES = {
  current: [
    [0, 31.4],
    [0.1, 112.4],
    [0.25, 134.7],
    [0.5, 206.8],
    [0.75, 283.8],
    [0.9, 325.5],
    [0.99, 608.3],
    [1, 728.7],
  ],
  historic: [
    [0, 0.5],
    [0.1, 23.9],
    [0.25, 31.4],
    [0.5, 46.2],
    [0.75, 79.2],
    [0.9, 187.2],
    [0.99, 414.4],
    [1, 728.7],
  ],
}

// mulberry32: tiny, deterministic, no dependency. Seeded runs are reproducible,
// which matters because every sweep cell is scored across several seeds.
function makeRng(seed = 1) {
  let a = seed >>> 0
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Piecewise-linear inverse CDF over the knot table.
function sampleGapMinutes(knots, u) {
  for (let i = 1; i < knots.length; i += 1) {
    const [q0, v0] = knots[i - 1]
    const [q1, v1] = knots[i]
    if (u <= q1) {
      const span = q1 - q0
      const frac = span === 0 ? 0 : (u - q0) / span
      return v0 + frac * (v1 - v0)
    }
  }
  return knots[knots.length - 1][1]
}

// Returns ascending poll timestamps (ms) over [from, to].
//
//   mode 'bar'        one poll just after each bar close -- the unreachable
//                     upper bound, i.e. "what if we never missed a signal"
//   mode 'fixed'      every intervalMs
//   mode 'empirical'  sampled from a measured gap distribution
function pollTimes({
  mode = 'empirical',
  from,
  to,
  intervalMs = 30 * 60000,
  barMs = 3600000,
  regime = 'current',
  quantiles = null,
  rng = makeRng(1),
}) {
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  const out = []

  if (mode === 'bar') {
    // Align to the bar grid and poll 1ms after each close.
    let t = Math.ceil(start / barMs) * barMs
    for (; t <= end; t += barMs) out.push(t + 1)
    return out
  }

  if (mode === 'fixed') {
    for (let t = start; t <= end; t += intervalMs) out.push(t)
    return out
  }

  const knots = quantiles || GAP_QUANTILES[regime]
  if (!knots) throw new Error(`Unknown cadence regime: ${regime}`)
  let t = start
  while (t <= end) {
    out.push(t)
    t += sampleGapMinutes(knots, rng()) * 60000
  }
  return out
}

function cadenceStats(times) {
  if (times.length < 2) return { polls: times.length, meanGapMin: null, perDay: null }
  const gaps = []
  for (let i = 1; i < times.length; i += 1) gaps.push((times[i] - times[i - 1]) / 60000)
  const sorted = [...gaps].sort((a, b) => a - b)
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
  return {
    polls: times.length,
    meanGapMin: Math.round(mean * 10) / 10,
    p50GapMin: Math.round(q(0.5) * 10) / 10,
    p90GapMin: Math.round(q(0.9) * 10) / 10,
    perDay: Math.round((1440 / mean) * 10) / 10,
  }
}

module.exports = { makeRng, pollTimes, cadenceStats, sampleGapMinutes, GAP_QUANTILES }
