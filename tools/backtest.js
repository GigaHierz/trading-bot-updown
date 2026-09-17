// Replay the strategy offline at realistic polling cadences.
//
//   node tools/backtest.js --from 2026-03-01 --to 2026-09-15
//   node tools/backtest.js --fetch-only --from 2026-03-01 --to 2026-09-15
//   node tools/backtest.js --sweep 'A.tpPct=0.03,0.06;A.timeStopHours=24,48,96' --seeds 5
//
// Default output is the cadence table: the same strategy at every-bar,
// nominal-cron and measured-cron polling. That comparison is the point --
// it separates "the signal is bad" from "we only look 6.5 times a day".
//
// Exits non-zero on failure, unlike health-report.js. A silently empty
// backtest is worse than a missing one.
require('dotenv').config({ quiet: true })

const config = require('../src/config')
const { loadHistory } = require('../src/backtest/history')
const { runBacktest } = require('../src/backtest/engine')
const { expandGrid, rankCells, formatTable } = require('../src/backtest/sweep')
const analytics = require('../src/analytics')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const FROM = arg('from', '2026-03-01')
const TO = arg('to', new Date().toISOString().slice(0, 10))
const SEEDS = Number(arg('seeds', 5))
const OFFLINE = Boolean(arg('offline', false))
const CELO_USD = Number(arg('celo-usd', 0.08))

const CADENCES = [
  { label: 'every bar (unreachable)', cadence: { mode: 'bar' } },
  { label: 'nominal cron (*/30)', cadence: { mode: 'fixed', intervalMs: 30 * 60000 } },
  { label: 'measured Aug (17/day)', cadence: { mode: 'empirical', regime: 'historic' } },
  { label: 'measured now (6.5/day)', cadence: { mode: 'empirical', regime: 'current' } },
]

async function loadAll() {
  const out = {}
  for (const market of config.sleeveMarkets.A) {
    out[market] = {
      interval: config.sleeves.A.interval,
      bars: await loadHistory({
        market,
        interval: config.sleeves.A.interval,
        from: FROM,
        to: TO,
        offline: OFFLINE,
      }),
    }
  }
  for (const market of config.sleeveMarkets.B) {
    out[market] = {
      interval: config.sleeves.B.interval,
      bars: await loadHistory({
        market,
        interval: config.sleeves.B.interval,
        from: FROM,
        to: TO,
        offline: OFFLINE,
      }),
    }
  }
  return out
}

const costs = {
  roundTripFeeRate: config.risk.roundTripFeeRate,
  slippageBps: config.risk.simSlippageBps,
  celoPerRoundTrip: config.risk.celoPerRoundTrip,
  celoUsd: CELO_USD,
}

// One cell = one parameter set, scored across N seeds of the same cadence.
async function scoreCell({ historyByMarket, paramsA, paramsB, cadence, seeds }) {
  const runs = []
  const deterministic = cadence.mode !== 'empirical'
  for (let s = 1; s <= (deterministic ? 1 : seeds); s += 1) {
    const res = await runBacktest({
      historyByMarket,
      from: FROM,
      to: TO,
      paramsA,
      paramsB,
      cadence,
      costs,
      seed: s,
    })
    const report = analytics.analyze({
      rows: res.trades,
      state: res.finalState,
      primaryMode: 'dry',
      costs: { ...costs, celoPerRoundTrip: 0 }, // already inside pnl via flatCostUsd
    })
    runs.push({
      net: res.equity.end - res.equity.start,
      trades: report.overall.primary.trades,
      winRate: report.overall.primary.winRate,
      expectancy: report.overall.primary.expectancy,
      expectancyBps: report.overall.primary.expectancyBps,
      stdErr: report.overall.primary.expectancyStdErr,
      profitFactor: report.overall.primary.profitFactor,
      maxDd: report.equity.drawdown.maxDdUsd,
      exits: report.byExitReason,
      staleSkips: res.staleSkips,
      cadenceStats: res.cadenceStats,
    })
  }
  const mean = (f) => runs.reduce((a, r) => a + (f(r) || 0), 0) / runs.length
  return {
    seeds: runs.length,
    net: Math.round(mean((r) => r.net) * 100) / 100,
    worstNet: Math.round(Math.min(...runs.map((r) => r.net)) * 100) / 100,
    trades: Math.round(mean((r) => r.trades)),
    winRate: Math.round(mean((r) => r.winRate) * 1000) / 1000,
    expectancy: Math.round(mean((r) => r.expectancy) * 1e4) / 1e4,
    expectancyBps: Math.round(mean((r) => r.expectancyBps) * 100) / 100,
    stdErr: Math.round(mean((r) => r.stdErr) * 1e4) / 1e4,
    profitFactor: Math.round(mean((r) => r.profitFactor) * 1000) / 1000,
    maxDd: Math.round(mean((r) => r.maxDd) * 100) / 100,
    staleSkips: Math.round(mean((r) => r.staleSkips)),
    cadenceStats: runs[0].cadenceStats,
    exits: runs[0].exits,
  }
}

async function main() {
  const historyByMarket = await loadAll()
  const bars = Object.entries(historyByMarket)
    .map(([m, h]) => `${m} ${h.bars.length}@${h.interval}`)
    .join(', ')

  if (arg('fetch-only')) {
    console.log(`Cached: ${bars}`)
    return
  }

  console.log(`## Backtest ${FROM} → ${TO}`)
  console.log('')
  console.log(`_History: ${bars}. Costs: ${(costs.roundTripFeeRate * 1e4).toFixed(0)}bp fee + ` +
    `${costs.slippageBps}bp slippage + ${costs.celoPerRoundTrip} CELO/trip at $${CELO_USD}._`)
  console.log('')

  const sweepSpec = arg('sweep')
  if (sweepSpec && sweepSpec !== true) {
    const grid = expandGrid(sweepSpec)
    const cadence = { mode: 'empirical', regime: 'current' }
    const cells = []
    for (const cell of grid) {
      const paramsA = { ...config.sleeves.A, ...cell.A }
      const paramsB = { ...config.sleeves.B, ...cell.B }
      const scored = await scoreCell({ historyByMarket, paramsA, paramsB, cadence, seeds: SEEDS })
      cells.push({ label: cell.label, ...scored })
    }
    const baseline = await scoreCell({
      historyByMarket,
      paramsA: config.sleeves.A,
      paramsB: config.sleeves.B,
      cadence,
      seeds: SEEDS,
    })
    console.log(`### Sweep at the measured cadence, ${SEEDS} seeds/cell`)
    console.log('')
    console.log(formatTable(rankCells(cells, baseline), baseline))
    return
  }

  console.log('### Same strategy, different polling cadence')
  console.log('')
  console.log('| cadence | runs/day | trades | win rate | net USD | expectancy | stale skips | max DD |')
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|')
  const results = []
  for (const c of CADENCES) {
    const s = await scoreCell({
      historyByMarket,
      paramsA: config.sleeves.A,
      paramsB: config.sleeves.B,
      cadence: c.cadence,
      seeds: SEEDS,
    })
    results.push({ label: c.label, ...s })
    const t = s.stdErr ? (s.expectancy / s.stdErr).toFixed(2) : 'n/a'
    console.log(
      `| ${c.label} | ${s.cadenceStats.perDay} | ${s.trades} | ` +
        `${s.winRate === null ? 'n/a' : (s.winRate * 100).toFixed(1) + '%'} | ` +
        `${s.net >= 0 ? '+' : ''}${s.net} | ${s.expectancy} ±${s.stdErr} (t=${t}) | ` +
        `${s.staleSkips} | -${s.maxDd} |`,
    )
  }

  const best = results[0]
  const live = results[results.length - 1]
  console.log('')
  console.log('### Read')
  const gap = best.net - live.net
  console.log(
    `- Every-bar polling produces ${best.trades} trades for ${best.net >= 0 ? '+' : ''}${best.net} USD; ` +
      `the cadence the bot actually gets produces ${live.trades} for ${live.net >= 0 ? '+' : ''}${live.net} USD. ` +
      `**Cadence gap: ${gap >= 0 ? '+' : ''}${Math.round(gap * 100) / 100} USD.**`,
  )
  console.log(
    `- Signals discarded by the staleness gate at the live cadence: ${live.staleSkips} ` +
      '(each one permanently burns that bar — src/index.js:145).',
  )
  for (const r of results) {
    if (r.stdErr && Math.abs(r.expectancy / r.stdErr) < 2) {
      console.log(`- ⚠️ "${r.label}": |t| < 2 at n=${r.trades} — not distinguishable from zero.`)
    }
  }
  console.log('')
  console.log('### Exit mix at the live cadence')
  console.log('| exit | n | net USD | win rate |')
  console.log('|---|---:|---:|---:|')
  for (const e of live.exits) {
    console.log(`| ${e.reason} | ${e.n} | ${e.netUsd >= 0 ? '+' : ''}${e.netUsd} | ${(e.winRate * 100).toFixed(0)}% |`)
  }
}

main().catch((err) => {
  console.error(`Backtest failed: ${err.message}`)
  process.exitCode = 1
})
