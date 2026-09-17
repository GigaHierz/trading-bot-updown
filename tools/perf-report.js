// Realized performance over the trade log. Markdown to stdout.
//
// Usage: node tools/perf-report.js [--days N] [--celo-usd X]
//
// Deliberately separate from health-report.js: that answers "is the bot
// alive", this answers "is the bot any good". Unlike health-report it exits
// non-zero on failure, because a silently empty performance report is worse
// than a missing one.
require('dotenv').config({ quiet: true })

const config = require('../src/config')
const a = require('../src/analytics')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`)
const usd = (x) => (x === null || x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}`)

function summaryLine(label, s, t = null) {
  if (!s.trades) return `- **${label}**: no closed trades`
  const edge =
    s.expectancyStdErr !== null
      ? `${usd(s.expectancy)} ± ${s.expectancyStdErr.toFixed(2)}/trade` +
        (t !== null ? ` (t=${t})` : '')
      : `${usd(s.expectancy)}/trade`
  return (
    `- **${label}**: ${s.trades} trades, ${s.wins}W/${s.losses}L (${pct(s.winRate)}), ` +
    `net ${usd(s.netPnlUsd)} USD, expectancy ${edge}, ` +
    `payoff ${s.payoffRatio ?? 'n/a'}, profit factor ${s.profitFactor ?? 'n/a'}`
  )
}

function main() {
  const days = arg('days', null)
  const celoUsd = Number(arg('celo-usd', 0.08))
  const { rows, badLines } = a.loadTradeRows()
  const state = a.loadState()
  const from = days ? new Date(Date.now() - Number(days) * 864e5).toISOString() : null

  const r = a.analyze({
    rows,
    state,
    from,
    costs: {
      celoPerRoundTrip: config.risk.celoPerRoundTrip,
      celoUsd,
      roundTripFeeRate: config.risk.roundTripFeeRate,
    },
  })

  const out = []
  out.push(`## Performance${days ? ` — last ${days}d` : ' — since inception'}`)
  out.push('')
  out.push(
    `_${r.span.from ? r.span.from.slice(0, 10) : 'n/a'} → ` +
      `${r.span.to ? r.span.to.slice(0, 10) : 'n/a'} (${r.span.days ?? 'n/a'} days)_`,
  )
  out.push('')

  out.push(summaryLine('Live', r.overall.live, r.tStat))
  if (r.tStat !== null && Math.abs(r.tStat) < 2) {
    out.push(
      `  - ⚠️ |t| < 2: this result is not distinguishable from zero at n=${r.overall.live.trades}. ` +
        'Do not tune parameters on it.',
    )
  }
  for (const [name, s] of Object.entries(r.bySleeve)) {
    out.push(summaryLine(`Sleeve ${name} (${config.sleeves[name]?.label ?? '?'})`, s))
  }
  for (const [market, s] of Object.entries(r.byMarket)) {
    out.push(`  ${summaryLine(market, s)}`)
  }

  out.push('')
  out.push('### True cost')
  const c = r.costs
  out.push(
    `- Booked PnL ${usd(c.netBookedUsd)} USD, but the ledger never charges the CELO ` +
      `execution fee: ${c.gasCelo} CELO ≈ ${usd(-c.gasUsd)} USD at $${celoUsd}/CELO.`,
  )
  out.push(
    `- **Net after gas: ${usd(c.netAfterGasUsd)} USD.** Total cost ${c.totalCostUsd} USD ` +
      `on ${c.totalNotionalUsd} USD notional = **${c.costBpsOfNotional} bps**, vs the ` +
      `${(config.risk.roundTripFeeRate * 1e4).toFixed(0)} bps the strategy models.`,
  )

  out.push('')
  out.push('### Where the money goes')
  out.push('| exit | n | net USD | avg USD | win rate | avg hold |')
  out.push('|---|---:|---:|---:|---:|---:|')
  for (const e of r.byExitReason) {
    out.push(
      `| ${e.reason} | ${e.n} | ${usd(e.netUsd)} | ${usd(e.avgUsd)} | ${pct(e.winRate)} | ${e.avgHoldHours}h |`,
    )
  }

  out.push('')
  out.push('### Execution')
  out.push(
    `- Entry slip vs signal bar: mean ${r.entrySlip.meanPct ?? 'n/a'}%, ` +
      `worst ${r.entrySlip.worstPct ?? 'n/a'}% over ${r.entrySlip.n} fills.`,
  )
  out.push(
    `- Max drawdown ${usd(-r.equity.drawdown.maxDdUsd)} USD (${pct(r.equity.drawdown.maxDdPct)}) ` +
      `from ${r.equity.startEquity} USD start.`,
  )
  out.push(
    `- Time in market ${r.timeInMarket.coverageHours}h of ${r.timeInMarket.windowHours ?? 'n/a'}h ` +
      `(${pct(r.timeInMarket.coveragePct)}), avg hold ${r.overall.live.avgHoldHours ?? 'n/a'}h.`,
  )

  const an = r.anomalies
  const notes = []
  if (an.mixedModeTrips.length) {
    notes.push(
      `${an.mixedModeTrips.length} trip(s) opened dry and closed live (excluded from the live figures)`,
    )
  }
  if (an.orphanCloses.length) notes.push(`${an.orphanCloses.length} close(s) with no matching open`)
  if (r.open.length) notes.push(`${r.open.length} position(s) still open`)
  if (badLines.length) notes.push(`${badLines.length} unparseable log line(s)`)
  for (const [name, drift] of Object.entries(an.ledgerDrift)) {
    if (Math.abs(drift) > 0.01) {
      notes.push(`sleeve ${name} equity drifts ${usd(drift)} from the sum of its trades`)
    }
  }
  if (notes.length) {
    out.push('')
    out.push('### Anomalies')
    notes.forEach((n) => out.push(`- ${n}`))
  }

  console.log(out.join('\n'))
}

main()
