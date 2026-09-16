// Performance metrics over paired round trips. Pure: no fs, no clock, no
// network. The backtest scores its output with these same functions, so a
// live-vs-backtest gap can never be a measurement artifact.

const r2 = (n) => Math.round(n * 100) / 100
const r4 = (n) => Math.round(n * 1e4) / 1e4

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function stdev(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

function summarize(trips) {
  const pnls = trips.map((t) => t.pnlUsd).filter((p) => typeof p === 'number')
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p <= 0)
  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const sd = stdev(pnls)
  const meanWin = wins.length ? mean(wins) : null
  const meanLoss = losses.length ? mean(losses) : null
  const holds = trips.map((t) => t.holdHours).filter((h) => typeof h === 'number')
  const notionals = trips.map((t) => t.notionalUsd).filter((n) => typeof n === 'number')

  return {
    trades: pnls.length,
    wins: wins.length,
    losses: losses.length,
    winRate: pnls.length ? r4(wins.length / pnls.length) : null,
    meanWin: meanWin === null ? null : r4(meanWin),
    meanLoss: meanLoss === null ? null : r4(meanLoss),
    // Reward:risk actually achieved, not the configured TP/SL ratio.
    payoffRatio: meanWin !== null && meanLoss ? r4(Math.abs(meanWin / meanLoss)) : null,
    expectancy: pnls.length ? r4(mean(pnls)) : null,
    // Reported next to expectancy on purpose: at n=12 the observed edge is
    // about one standard error from zero, and a number without its error is
    // how you talk yourself into tuning on noise.
    expectancyStdErr: sd === null ? null : r4(sd / Math.sqrt(pnls.length)),
    grossProfit: r4(grossProfit),
    grossLoss: r4(grossLoss),
    // null rather than Infinity, so it cannot leak into a report.
    profitFactor: grossLoss > 0 ? r4(grossProfit / grossLoss) : null,
    netPnlUsd: r2(pnls.reduce((a, b) => a + b, 0)),
    avgNotionalUsd: notionals.length ? r2(mean(notionals)) : null,
    avgHoldHours: holds.length ? r2(mean(holds)) : null,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
  }
}

// |t| < 2 means the result is indistinguishable from zero at this sample size.
function tStat(summary) {
  if (!summary.expectancyStdErr) return null
  return r2(summary.expectancy / summary.expectancyStdErr)
}

function equityCurve(trips, startEquity = 0) {
  let equity = startEquity
  const points = [{ ts: null, equity: r2(equity) }]
  for (const t of trips) {
    if (typeof t.pnlUsd !== 'number') continue
    equity += t.pnlUsd
    points.push({ ts: t.closeTs, equity: r2(equity) })
  }
  return points
}

function maxDrawdown(points) {
  let peak = -Infinity
  let peakTs = null
  let maxDdUsd = 0
  let maxDdPct = 0
  let troughTs = null
  let atPeakTs = null
  for (const p of points) {
    if (p.equity > peak) {
      peak = p.equity
      peakTs = p.ts
    }
    const dd = peak - p.equity
    if (dd > maxDdUsd) {
      maxDdUsd = dd
      maxDdPct = peak > 0 ? dd / peak : 0
      troughTs = p.ts
      atPeakTs = peakTs
    }
  }
  return { maxDdUsd: r2(maxDdUsd), maxDdPct: r4(maxDdPct), peakTs: atPeakTs, troughTs }
}

function exitReasonHistogram(trips) {
  const by = new Map()
  for (const t of trips) {
    if (typeof t.pnlUsd !== 'number') continue
    if (!by.has(t.exitReason)) by.set(t.exitReason, [])
    by.get(t.exitReason).push(t)
  }
  return [...by.entries()]
    .map(([reason, group]) => {
      const s = summarize(group)
      return {
        reason,
        n: s.trades,
        netUsd: s.netPnlUsd,
        avgUsd: s.expectancy,
        winRate: s.winRate,
        avgHoldHours: s.avgHoldHours,
      }
    })
    .sort((a, b) => b.n - a.n)
}

// positionHours double-counts concurrent sleeve-A positions; coverageHours is
// the union. Reporting only the sum overstates exposure.
function timeInMarket(trips, { from, to } = {}) {
  const spans = trips
    .filter((t) => t.openTs && t.closeTs)
    .map((t) => [new Date(t.openTs).getTime(), new Date(t.closeTs).getTime()])
    .sort((a, b) => a[0] - b[0])
  const positionHours = spans.reduce((a, [s, e]) => a + (e - s) / 3.6e6, 0)

  const merged = []
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }
  const coverageHours = merged.reduce((a, [s, e]) => a + (e - s) / 3.6e6, 0)
  const windowHours =
    from && to ? (new Date(to) - new Date(from)) / 3.6e6 : null
  return {
    positionHours: r2(positionHours),
    coverageHours: r2(coverageHours),
    windowHours: windowHours === null ? null : r2(windowHours),
    coveragePct: windowHours ? r4(coverageHours / windowHours) : null,
  }
}

// The protocol fee is already inside pnlUsd (reconcile.js applies it). The CELO
// execution fee is not booked anywhere, which is why the ledger flatters the
// real result. Costs are passed in; this never fetches a price.
function costDrag(trips, { celoPerRoundTrip = 0, celoUsd = 0, roundTripFeeRate = 0 } = {}) {
  const priced = trips.filter((t) => typeof t.pnlUsd === 'number')
  const notional = priced.reduce((a, t) => a + (t.notionalUsd || 0), 0)
  const modeledFeesUsd = notional * roundTripFeeRate
  const gasCelo = priced.length * celoPerRoundTrip
  const gasUsd = gasCelo * celoUsd
  const netAfterFees = priced.reduce((a, t) => a + t.pnlUsd, 0)
  return {
    trades: priced.length,
    totalNotionalUsd: r2(notional),
    modeledFeesUsd: r2(modeledFeesUsd),
    gasCelo: r2(gasCelo),
    gasUsd: r2(gasUsd),
    // What the ledger says, and what the wallet actually experienced.
    netBookedUsd: r2(netAfterFees),
    netAfterGasUsd: r2(netAfterFees - gasUsd),
    totalCostUsd: r2(modeledFeesUsd + gasUsd),
    costBpsOfNotional: notional > 0 ? r2(((modeledFeesUsd + gasUsd) / notional) * 1e4) : null,
  }
}

module.exports = {
  summarize,
  tStat,
  equityCurve,
  maxDrawdown,
  exitReasonHistogram,
  timeInMarket,
  costDrag,
  mean,
  stdev,
}
