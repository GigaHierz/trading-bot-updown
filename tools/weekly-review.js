// Weekly strategy review. Markdown to stdout; the workflow commits it under
// reports/weekly/ and posts it to the tracking issue.
//
// health-report.js answers "is the bot alive". perf-report.js answers "what
// did it earn". This answers "what happened and what did the loop decide".
//
// This file itself is read-only; the config changes are made by
// tools/auto-tune.js, which the same workflow runs, and whose report is
// appended below this one. The split is deliberate: decisions are made against
// out-of-sample BACKTEST evidence, never against the live week, because a week
// is about two trades. Everything here carries its sample size for that
// reason.
//
// Usage: node tools/weekly-review.js [--days 7] [--celo-usd 0.08] [--no-uptime]

require('dotenv').config({ quiet: true })
const { execFileSync } = require('child_process')

const config = require('../src/config')
const a = require('../src/analytics')
const { gasBurn } = require('../src/state/store')
const tuningStore = require('../src/tuning')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const next = process.argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const DAYS = Number(arg('days', 7))
const CELO_USD = Number(arg('celo-usd', 0.08))
// Below this many closed trades in the window, no parameter change is
// recommendable -- the noise is larger than any effect worth acting on.
const MIN_TRADES_TO_RECOMMEND = 30

const usd = (x) => (x === null || x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`)
const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`)

// Every bot run commits to state/, so commit timestamps are run timestamps.
// This is the only honest source for "did the schedule actually fire".
function uptime(sinceIso) {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%ct', `--since=${sinceIso}`, '--', 'state/state.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const ts = out.trim().split('\n').filter(Boolean).map(Number).sort((x, y) => x - y)
    if (ts.length < 3) return null
    const gaps = []
    for (let i = 1; i < ts.length; i += 1) gaps.push((ts[i] - ts[i - 1]) / 60)
    const sorted = [...gaps].sort((x, y) => x - y)
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
    const mean = gaps.reduce((x, y) => x + y, 0) / gaps.length
    return {
      runs: ts.length,
      perDay: Math.round((1440 / mean) * 10) / 10,
      p50: Math.round(q(0.5)),
      p90: Math.round(q(0.9)),
      max: Math.round(sorted[sorted.length - 1]),
      nominalPerDay: 48,
    }
  } catch {
    return null
  }
}

function main() {
  const now = new Date()
  const from = new Date(now.getTime() - DAYS * 864e5).toISOString()
  const { rows, badLines } = a.loadTradeRows()
  const state = a.loadState()
  const costs = {
    celoPerRoundTrip: config.risk.celoPerRoundTrip,
    celoUsd: CELO_USD,
    roundTripFeeRate: config.risk.roundTripFeeRate,
  }

  const week = a.analyze({ rows, state, from, now, costs })
  const all = a.analyze({ rows, state, now, costs })

  const out = []
  const stamp = now.toISOString().slice(0, 10)
  out.push(`# Weekly strategy review — ${stamp}`)
  out.push('')

  // --- 1. Trading -------------------------------------------------------
  out.push('## 1. Trading')
  out.push('')
  const w = week.overall.live
  const t = all.overall.live
  out.push(
    `| window | trades | W/L | win rate | net USD | expectancy | edge bps/trade |`,
  )
  out.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const [label, s, ts] of [[`last ${DAYS}d`, w, week.tStat], ['since inception', t, all.tStat]]) {
    out.push(
      `| ${label} | ${s.trades} | ${s.wins}/${s.losses} | ${pct(s.winRate)} | ` +
        `${usd(s.netPnlUsd)} | ${s.expectancy ?? 'n/a'} ±${s.expectancyStdErr ?? 'n/a'}` +
        `${ts === null ? '' : ` (t=${ts})`} | ${s.expectancyBps ?? 'n/a'} |`,
    )
  }
  out.push('')
  if (all.tStat !== null && Math.abs(all.tStat) < 2) {
    out.push(
      `> ⚠️ Since inception |t| = ${Math.abs(all.tStat)} at n=${t.trades}. The realized ` +
        'result is not distinguishable from zero. Treat any ranking below as a hypothesis.',
    )
    out.push('')
  }
  if (all.byExitReason.length) {
    out.push('| exit | n | net USD | win rate | avg hold |')
    out.push('|---|---:|---:|---:|---:|')
    for (const e of all.byExitReason) {
      out.push(`| ${e.reason} | ${e.n} | ${usd(e.netUsd)} | ${pct(e.winRate)} | ${e.avgHoldHours}h |`)
    }
    out.push('')
  }
  out.push(
    `- **True cost**: booked ${usd(all.costs.netBookedUsd)} USD, but the ledger never charges ` +
      `execution fees. ${all.costs.gasCelo} CELO ≈ ${usd(-all.costs.gasUsd)} USD → ` +
      `**net after gas ${usd(all.costs.netAfterGasUsd)} USD**, ` +
      `${all.costs.costBpsOfNotional} bps of notional vs the ` +
      `${(config.risk.roundTripFeeRate * 1e4).toFixed(0)} bps modelled.`,
  )

  // --- 2. Uptime and gates ---------------------------------------------
  out.push('')
  out.push('## 2. Uptime & gates')
  out.push('')
  const up = arg('no-uptime') ? null : uptime(from)
  if (up) {
    out.push(
      `- Runs delivered: **${up.runs} in ${DAYS}d = ${up.perDay}/day** against a nominal ` +
        `${up.nominalPerDay}/day. Gap p50 ${up.p50}min, p90 ${up.p90}min, max ${up.max}min.`,
    )
  } else {
    out.push('- Run cadence unavailable (needs git history for state/state.json).')
  }
  if (state) {
    const trips = all.overall.all.trades
    const burn = gasBurn(state, trips)
    const bal = state.gas?.lastBalance
    const perTrip = burn.perTripCelo || config.risk.celoPerRoundTrip
    const left = bal === null || bal === undefined
      ? null
      : Math.max(0, Math.floor((bal - config.risk.minCeloForEntry) / perTrip))
    out.push(
      `- Gas: ${bal ?? 'n/a'} CELO, burn ~${perTrip}/round trip → **~${left ?? 'n/a'} more entries**` +
        (burn.perDayCelo ? ` (~${(bal / burn.perDayCelo).toFixed(1)} days)` : ''),
    )
    for (const [name, sleeve] of Object.entries(state.sleeves || {})) {
      if (sleeve.halted) out.push(`- 🛑 Sleeve ${name} is HALTED at ${sleeve.equity} USD.`)
    }
  }
  if (week.timeInMarket.coveragePct !== null) {
    out.push(
      `- Time in market: ${pct(week.timeInMarket.coveragePct)} of the window ` +
        `(${week.timeInMarket.coverageHours}h of ${week.timeInMarket.windowHours}h).`,
    )
  }

  // --- 3. Anomalies -----------------------------------------------------
  const notes = []
  if (all.anomalies.orphanCloses.length) {
    notes.push(`${all.anomalies.orphanCloses.length} close(s) with no matching open`)
  }
  if (all.anomalies.mixedModeTrips.length) {
    notes.push(`${all.anomalies.mixedModeTrips.length} trip(s) spanning dry and live`)
  }
  if (badLines.length) notes.push(`${badLines.length} unparseable trade-log line(s)`)
  for (const [name, drift] of Object.entries(all.anomalies.ledgerDrift)) {
    if (Math.abs(drift) > 0.01) {
      notes.push(`sleeve ${name} equity drifts ${usd(drift)} from the sum of its trades`)
    }
  }
  const unattributed = all.byExitReason.find((e) => e.reason === 'unattributed')
  if (unattributed) {
    notes.push(`${unattributed.n} exit(s) the bot could not attribute to TP or SL`)
  }
  if (notes.length) {
    out.push('')
    out.push('## 3. Anomalies')
    out.push('')
    notes.forEach((n) => out.push(`- ${n}`))
  }

  // --- 4. Decision ------------------------------------------------------
  out.push('')
  out.push('## 4. Decision')
  out.push('')
  const verdict = []
  let call = 'CONTINUE'

  const tune = tuningStore.load()
  if (tune.tradingEnabled === false) {
    call = 'HALT'
    verdict.push(
      `Entries are **switched off** by auto-tune (generation ${tune.generation}` +
        `${tune.appliedAt ? `, ${tune.appliedAt.slice(0, 10)}` : ''}). Nothing in the search space ` +
        'was profitable after costs. Exits and protection still run.',
    )
  } else if (tune.generation > 0) {
    const ev = tune.evidence || {}
    verdict.push(
      `Running auto-tuned generation ${tune.generation}` +
        (ev.oosBps ? ` (promoted on ${ev.oosBps} bps/trade out-of-sample, n=${ev.oosTrades})` : '') +
        '.',
    )
  }

  if (state && Object.values(state.sleeves || {}).some((s) => s.halted)) {
    call = 'HALT'
    verdict.push('A sleeve has hit its drawdown floor and stopped. That is a decision point, not a glitch.')
  }
  if (t.trades < MIN_TRADES_TO_RECOMMEND) {
    verdict.push(
      `Only ${t.trades} closed trades live since inception (need ${MIN_TRADES_TO_RECOMMEND} ` +
        'before the live log can say anything). Tuning decisions come from the ' +
        'out-of-sample backtest below, not from this number.',
    )
  } else if (all.tStat !== null && all.tStat < -2) {
    call = 'HALT'
    verdict.push(
      `Realized edge is significantly negative (t=${all.tStat} at n=${t.trades}). ` +
        'This is not noise. Stop before tuning.',
    )
  } else if (all.tStat !== null && Math.abs(all.tStat) < 2) {
    call = 'CONTINUE'
    verdict.push(
      `Edge is indistinguishable from zero (t=${all.tStat} at n=${t.trades}). Keep collecting; ` +
        'do not tune.',
    )
  }
  if (all.costs.costBpsOfNotional && all.costs.costBpsOfNotional > 100) {
    verdict.push(
      `Costs are ${all.costs.costBpsOfNotional} bps per round trip. At this position size the ` +
        'strategy needs an implausible gross edge just to break even — size up or stop.',
    )
  }

  out.push(`**${call}**`)
  out.push('')
  verdict.forEach((v) => out.push(`- ${v}`))
  out.push('')
  out.push(
    '_Config changes are decided by the auto-tune report below, against ' +
      'out-of-sample backtest evidence — never against this live week, which is ' +
      'far too small a sample to rank anything. Risk gates, the CELO reserve and ' +
      'the drawdown halt are not tunable._',
  )

  console.log(out.join('\n'))
}

main()
