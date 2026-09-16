const { parseRows, pairRoundTrips, normalizeExitReason } = require('./roundtrips')
const m = require('./metrics')
const { stateDir, loadTradeRows, loadState } = require('./load')

const r2 = (n) => Math.round(n * 100) / 100

// One report over a set of trade-log rows. `now` is injected, never read from
// the clock, so reports are reproducible.
// `primaryMode` selects which bucket drives the curve, exit mix and costs.
// Live reports want 'live'; the backtest emits simulated trips and wants 'dry'.
function analyze({
  rows,
  state = null,
  now = new Date(),
  costs = {},
  from = null,
  to = null,
  primaryMode = 'live',
}) {
  const windowed = rows.filter((row) => {
    const ts = new Date(row.ts)
    if (from && ts < new Date(from)) return false
    if (to && ts > new Date(to)) return false
    return true
  })
  const { trips, openTrips, orphanCloses } = pairRoundTrips(windowed)

  const live = trips.filter((t) => t.mode === 'live')
  const dry = trips.filter((t) => t.mode === 'dry')
  const mixed = trips.filter((t) => t.mode === 'mixed')
  const primary = primaryMode === 'dry' ? dry : live

  const groupBy = (list, pick) => {
    const out = {}
    for (const t of list) (out[pick(t)] = out[pick(t)] || []).push(t)
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, m.summarize(v)]))
  }

  const overallPrimary = m.summarize(primary)
  // Anchor the curve to real starting capital; a curve starting at 0 makes
  // drawdown-as-a-percentage meaningless for a net-losing series.
  const startEquity = state
    ? Object.values(state.sleeves || {}).reduce((a, s) => a + (s.initialEquity || 0), 0)
    : 0
  const curve = m.equityCurve(primary, startEquity)
  const span = {
    from: from || (windowed.length ? windowed[0].ts : null),
    to: to || (windowed.length ? windowed[windowed.length - 1].ts : null),
  }
  span.days = span.from && span.to ? r2((new Date(span.to) - new Date(span.from)) / 864e5) : null

  // A sleeve's booked equity change must equal the sum of its realized PnL.
  // Catches a hand-edited state.json or a backfilled log.
  const ledgerDrift = {}
  if (state) {
    for (const [name, sleeve] of Object.entries(state.sleeves || {})) {
      const booked = sleeve.equity - sleeve.initialEquity
      const summed = trips
        .filter((t) => t.sleeve === name && typeof t.pnlUsd === 'number')
        .reduce((a, t) => a + t.pnlUsd, 0)
      ledgerDrift[name] = r2(booked - summed)
    }
  }

  const slips = primary.map((t) => t.entrySlipPct).filter((s) => typeof s === 'number')

  return {
    generatedAt: new Date(now).toISOString(),
    span,
    overall: { live: m.summarize(live), dry: m.summarize(dry), all: m.summarize(trips), primary: overallPrimary },
    primaryMode,
    tStat: m.tStat(overallPrimary),
    bySleeve: groupBy(primary, (t) => t.sleeve),
    byMarket: groupBy(primary, (t) => t.market),
    byExitReason: m.exitReasonHistogram(primary),
    equity: { startEquity: r2(startEquity), curve, drawdown: m.maxDrawdown(curve) },
    timeInMarket: m.timeInMarket(primary, span),
    costs: m.costDrag(primary, costs),
    // How far the keeper fill drifted from the signal-bar close: a direct
    // measure of what the polling gap costs before the trade even starts.
    entrySlip: {
      n: slips.length,
      meanPct: slips.length ? r2(m.mean(slips) * 100) : null,
      worstPct: slips.length ? r2(Math.min(...slips) * 100) + 0 : null,
    },
    open: openTrips,
    anomalies: { orphanCloses, mixedModeTrips: mixed, ledgerDrift },
  }
}

module.exports = {
  analyze,
  parseRows,
  pairRoundTrips,
  normalizeExitReason,
  stateDir,
  loadTradeRows,
  loadState,
  ...m,
}
