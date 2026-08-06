// Twice-daily health check: workflow liveness, sleeve state, wallet balances.
// Prints a markdown report to stdout (posted to a GitHub issue by report.yml).
require('dotenv').config({ quiet: true })
const fs = require('fs')
const path = require('path')

const config = require('../src/config')
const { snapshot } = require('../src/exchange/chain-read')

const STATE = path.join(__dirname, '../state/state.json')
const TRADES = path.join(__dirname, '../state/trades.ndjson')
const SYMBOLS = ['BTC', 'ETH', 'CELO']
const STALE_RUN_HOURS = 2
const MIN_TOTAL_EQUITY = 12
const MIN_CELO = config.risk.minCeloForEntry

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'))
  const snap = await snapshot(SYMBOLS)
  const alerts = []
  const lines = []

  const lastRunAgeH = (Date.now() - new Date(state.lastRunAt)) / 3.6e6
  if (lastRunAgeH > STALE_RUN_HOURS) {
    alerts.push(`bot has not run for ${lastRunAgeH.toFixed(1)}h — check the Actions tab / BOT_ENABLED`)
  }

  let totalEquity = 0
  for (const [name, sleeve] of Object.entries(state.sleeves)) {
    totalEquity += sleeve.equity
    if (sleeve.halted) alerts.push(`sleeve ${name} is HALTED`)
    const marks = []
    for (const [market, p] of Object.entries(sleeve.positions)) {
      const ageH = (Date.now() - new Date(p.openedAt)) / 3.6e6
      if ((p.status === 'pending_open' || p.status === 'closing') && ageH > 2) {
        alerts.push(`sleeve ${name}/${market} stuck in status "${p.status}" for ${ageH.toFixed(1)}h`)
      }
      const price = snap.prices[market]
      const dir = p.isLong ? 1 : -1
      const upnl =
        p.status === 'open' && price
          ? p.notionalUsd * ((price - p.entryPrice) / p.entryPrice) * dir
          : null
      marks.push(
        `${market} ${p.isLong ? 'long' : 'short'} ${p.notionalUsd} USD @ ${p.entryPrice}` +
          (upnl !== null ? ` (uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)})` : ` [${p.status}]`),
      )
    }
    const delta = sleeve.equity - sleeve.initialEquity
    lines.push(
      `- **Sleeve ${name}** (${config.sleeves[name].label}): ${sleeve.equity.toFixed(2)} USD ` +
        `(${delta >= 0 ? '+' : ''}${delta.toFixed(2)} since start)` +
        `${sleeve.halted ? ' 🛑 HALTED' : ''}${marks.length ? ' — ' + marks.join('; ') : ''}`,
    )
  }
  if (totalEquity < MIN_TOTAL_EQUITY) {
    alerts.push(`combined equity ${totalEquity.toFixed(2)} USD is below ${MIN_TOTAL_EQUITY} (deep drawdown)`)
  }
  if (snap.celoBalance < MIN_CELO) {
    alerts.push(`CELO balance ${snap.celoBalance.toFixed(2)} < ${MIN_CELO} — bot cannot open new positions; top up CELO`)
  }

  let tradeLines = []
  if (fs.existsSync(TRADES)) {
    tradeLines = fs.readFileSync(TRADES, 'utf8').trim().split('\n').slice(-8).map((l) => {
      const t = JSON.parse(l)
      return `  - ${t.ts.slice(0, 16)} ${t.sleeve}/${t.market} ${t.side} ${t.action}` +
        (t.pnlUsd !== undefined ? ` → ${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd} USD` : '') +
        (t.dry ? ' (dry)' : '')
    })
  }

  const verdict = alerts.length
    ? `🚨 **ATTENTION** — ${alerts.join('; ')}`
    : '✅ **ALL GOOD**'

  console.log(`${verdict}`)
  console.log('')
  lines.forEach((l) => console.log(l))
  console.log(
    `- **Wallet**: ${snap.celoBalance.toFixed(2)} CELO, ${snap.wusdtBalance.toFixed(2)} wUSDT, ` +
      `${snap.positions.length} on-chain position(s), ${snap.orders.length} resident order(s)`,
  )
  console.log(`- **Last bot run**: ${state.lastRunAt} (${lastRunAgeH.toFixed(1)}h ago)`)
  if (tradeLines.length) {
    console.log('- **Recent trades**:')
    tradeLines.forEach((l) => console.log(l))
  } else {
    console.log('- **Recent trades**: none yet')
  }
  process.exitCode = 0
}

main().catch((err) => {
  console.log(`🚨 **ATTENTION** — health check itself failed: ${err.message.slice(0, 300)}`)
  process.exitCode = 0 // still post the report
})
