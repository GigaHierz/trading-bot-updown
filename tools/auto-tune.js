// The self-improving half of the weekly loop.
//
//   search the parameter space on TRAIN
//     -> validate the top candidates on OUT-OF-SAMPLE
//       -> promote only if the gate passes
//         -> otherwise leave the config alone
//           -> and if the incumbent itself is significantly losing, stop trading
//
// Writes state/tuning.json, which src/config.js merges into the live config.
// Nothing else in the bot is touched: risk gates, the CELO reserve and the
// drawdown halt are not tunable, so the worst a bad promotion can do is trade
// badly inside limits that still hold.
//
// Usage:
//   node tools/auto-tune.js --apply            # search, promote, write
//   node tools/auto-tune.js                    # dry run, report only
//   node tools/auto-tune.js --months 9 --seeds 5 --top 6
require('dotenv').config({ quiet: true })

const config = require('../src/config')
const tuningStore = require('../src/tuning')
const { loadHistory } = require('../src/backtest/history')
const { runBacktest } = require('../src/backtest/engine')
const { expandGrid } = require('../src/backtest/sweep')
const {
  splitWindow,
  promotionGate,
  shouldDisableTrading,
  shouldRollback,
  DEFAULTS,
} = require('../src/backtest/promote')
const analytics = require('../src/analytics')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const APPLY = Boolean(arg('apply', false))
const MONTHS = Number(arg('months', 9))
const SEEDS = Number(arg('seeds', 5))
const TOP = Number(arg('top', 6))
const OOS_FRAC = Number(arg('oos-frac', 0.3))
const CELO_USD = Number(arg('celo-usd', 0.08))
const OFFLINE = Boolean(arg('offline', false))

const TO = arg('to', new Date().toISOString().slice(0, 10))
const FROM = arg(
  'from',
  new Date(new Date(TO).getTime() - MONTHS * 30.4 * 864e5).toISOString().slice(0, 10),
)

// The search space. Every key must appear in src/tuning.js BOUNDS or the
// promotion is rejected at write time.
const GRID =
  arg('sweep') && arg('sweep') !== true
    ? String(arg('sweep'))
    : [
        'A.tpPct=0.02,0.04,0.06,0.10',
        'A.slPct=0.01,0.02,0.025,0.04',
        'A.timeStopHours=12,24,48,96',
      ].join(';')

const costs = {
  roundTripFeeRate: config.risk.roundTripFeeRate,
  slippageBps: config.risk.simSlippageBps,
  celoPerRoundTrip: config.risk.celoPerRoundTrip,
  celoUsd: CELO_USD,
}

async function loadAll(from, to) {
  const out = {}
  const want = [
    ...config.sleeveMarkets.A.map((m) => [m, config.sleeves.A.interval]),
    ...config.sleeveMarkets.B.map((m) => [m, config.sleeves.B.interval]),
  ]
  for (const [market, interval] of want) {
    out[market] = {
      interval,
      bars: await loadHistory({ market, interval, from, to, offline: OFFLINE }),
    }
  }
  return out
}

async function score({ historyByMarket, paramsA, paramsB, from, to, seeds }) {
  const runs = []
  for (let s = 1; s <= seeds; s += 1) {
    const res = await runBacktest({
      historyByMarket,
      from,
      to,
      paramsA,
      paramsB,
      cadence: { mode: 'empirical', regime: 'current' },
      costs,
      seed: s,
    })
    const rep = analytics.analyze({
      rows: res.trades,
      state: res.finalState,
      primaryMode: 'dry',
      costs: { ...costs, celoPerRoundTrip: 0 }, // already inside pnl
    })
    const p = rep.overall.primary
    runs.push({
      net: res.equity.end - res.equity.start,
      trades: p.trades,
      expectancyBps: p.expectancyBps || 0,
      expectancy: p.expectancy || 0,
      stdErr: p.expectancyStdErr || 0,
      winRate: p.winRate,
    })
  }
  const mean = (f) => runs.reduce((a, r) => a + (f(r) || 0), 0) / runs.length
  const r4 = (n) => Math.round(n * 1e4) / 1e4
  return {
    seeds: runs.length,
    trades: Math.round(mean((r) => r.trades)),
    net: r4(mean((r) => r.net)),
    worstNet: r4(Math.min(...runs.map((r) => r.net))),
    expectancyBps: r4(mean((r) => r.expectancyBps)),
    expectancy: r4(mean((r) => r.expectancy)),
    stdErr: r4(mean((r) => r.stdErr)),
    winRate: r4(mean((r) => r.winRate)),
  }
}

function paramsFor(cell) {
  return {
    paramsA: { ...config.sleeves.A, ...(cell?.A || {}) },
    paramsB: { ...config.sleeves.B, ...(cell?.B || {}) },
  }
}

async function main() {
  const out = []
  const now = new Date().toISOString()
  const split = splitWindow(FROM, TO, OOS_FRAC)
  const history = await loadAll(FROM, TO)
  const current = tuningStore.load()

  out.push(`## Auto-tune — ${now.slice(0, 10)}`)
  out.push('')
  out.push(
    `_Train ${split.trainFrom.slice(0, 10)} → ${split.trainTo.slice(0, 10)}, ` +
      `out-of-sample ${split.oosFrom.slice(0, 10)} → ${split.oosTo.slice(0, 10)}. ` +
      `Generation ${current.generation}. ${APPLY ? 'APPLY' : 'dry run'}._`,
  )
  out.push('')

  const grid = expandGrid(GRID)

  // 1. Search on train only.
  const trained = []
  for (const cell of grid) {
    const { paramsA, paramsB } = paramsFor(cell)
    trained.push({
      cell,
      train: await score({
        historyByMarket: history,
        paramsA,
        paramsB,
        from: split.trainFrom,
        to: split.trainTo,
        seeds: SEEDS,
      }),
    })
  }
  trained.sort((a, b) => b.train.expectancyBps - a.train.expectancyBps)

  // 2. Validate only the top few out of sample. Validating everything would
  //    turn the OOS slice into a second training set.
  const finalists = trained.slice(0, TOP)
  for (const f of finalists) {
    const { paramsA, paramsB } = paramsFor(f.cell)
    f.oos = await score({
      historyByMarket: history,
      paramsA,
      paramsB,
      from: split.oosFrom,
      to: split.oosTo,
      seeds: SEEDS,
    })
  }

  // 3. The incumbent, scored the same way on the same OOS slice.
  const incumbent = await score({
    historyByMarket: history,
    ...paramsFor(null),
    from: split.oosFrom,
    to: split.oosTo,
    seeds: SEEDS,
  })

  out.push(`### Candidates (${grid.length} searched, top ${finalists.length} validated)`)
  out.push('')
  out.push('| params | train bps | OOS bps | OOS n | OOS t | worst seed |')
  out.push('|---|---:|---:|---:|---:|---:|')
  out.push(
    `| _incumbent (generation ${current.generation})_ | — | ${incumbent.expectancyBps} | ` +
      `${incumbent.trades} | ${incumbent.stdErr ? (incumbent.expectancy / incumbent.stdErr).toFixed(2) : 'n/a'} | ` +
      `${incumbent.worstNet} |`,
  )
  for (const f of finalists) {
    const t = f.oos.stdErr ? (f.oos.expectancy / f.oos.stdErr).toFixed(2) : 'n/a'
    out.push(
      `| ${f.cell.label} | ${f.train.expectancyBps} | ${f.oos.expectancyBps} | ` +
        `${f.oos.trades} | ${t} | ${f.oos.worstNet} |`,
    )
  }
  out.push('')

  // 4. The gate. Best OOS candidate only -- picking "the one that passes" out
  //    of many would reintroduce the selection bias the OOS split removes.
  const best = [...finalists].sort((a, b) => b.oos.expectancyBps - a.oos.expectancyBps)[0]
  const gate = best
    ? promotionGate({ candidate: best.oos, baseline: incumbent, train: best.train })
    : { promote: false, reasons: ['no candidates'], passed: [] }

  out.push('### Gate')
  out.push('')
  if (best) out.push(`Best out-of-sample candidate: \`${best.cell.label}\``)
  out.push('')
  for (const p of gate.passed) out.push(`- ✅ ${p}`)
  for (const r of gate.reasons) out.push(`- ❌ ${r}`)
  out.push('')

  const next = { ...current, history: [...(current.history || [])] }
  let action = 'no change'

  if (gate.promote) {
    const { overrides, rejected } = tuningStore.sanitize({ ...best.cell })
    if (rejected.length) {
      out.push('### Rejected by bounds')
      out.push('')
      rejected.forEach((r) => out.push(`- ⛔ ${r}`))
      out.push('')
      action = 'blocked by bounds'
    } else {
      next.generation = current.generation + 1
      next.appliedAt = now
      next.overrides = overrides
      next.evidence = {
        window: { ...split },
        trainBps: best.train.expectancyBps,
        oosBps: best.oos.expectancyBps,
        oosTrades: best.oos.trades,
        oosTStat: gate.tStat,
        incumbentOosBps: incumbent.expectancyBps,
      }
      next.history.push({
        ts: now,
        generation: next.generation,
        overrides,
        evidence: next.evidence,
        label: best.cell.label,
      })
      action = `promoted to generation ${next.generation}`
    }
  } else {
    // 5. Nothing beat the incumbent. Separate question: is the incumbent itself
    //    losing money? If so, the profitable move is to stop.
    const stop = shouldDisableTrading(incumbent)
    if (stop.disable && next.tradingEnabled) {
      next.tradingEnabled = false
      next.appliedAt = now
      next.evidence = { window: { ...split }, incumbentOosBps: incumbent.expectancyBps }
      next.history.push({ ts: now, generation: current.generation, disabled: true, reason: stop.reason })
      action = 'DISABLED TRADING'
      out.push(`> 🛑 **Stopping trading.** ${stop.reason}`)
      out.push('')
    } else if (!stop.disable && !next.tradingEnabled && incumbent.expectancyBps > 0) {
      // Re-enable only on positive OOS evidence, never just because time passed.
      next.tradingEnabled = true
      next.appliedAt = now
      next.history.push({ ts: now, generation: current.generation, reenabled: true })
      action = 're-enabled trading'
    }
  }

  out.push('### Action')
  out.push('')
  out.push(`**${action}**${APPLY ? '' : ' _(dry run — pass --apply to write)_'}`)
  if (gate.promote && action.startsWith('promoted')) {
    out.push('')
    out.push('```json')
    out.push(JSON.stringify(next.overrides, null, 2))
    out.push('```')
  }
  out.push('')
  out.push(
    `_Gate: OOS n ≥ ${DEFAULTS.minOosTrades}, |t| ≥ ${DEFAULTS.minTStat}, positive after full costs, ` +
      `≥ ${DEFAULTS.marginBps} bps better than the incumbent, every cadence seed profitable, ` +
      'train and OOS agreeing in sign. Risk gates and the drawdown halt are not tunable._',
  )

  if (APPLY && action !== 'no change') tuningStore.save(next)
  console.log(out.join('\n'))
}

main().catch((err) => {
  console.error(`Auto-tune failed: ${err.message}`)
  process.exitCode = 1
})
