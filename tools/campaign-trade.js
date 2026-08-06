// One-off campaign qualifier: a single >=$50-notional ETH round trip with
// paired on-exchange TP/SL, executed through the official skill scripts so it
// registers for the UPDOWN "AI Agent" incentive rewards (qualified trade >=$50
// + paired TP/SL usage). Position is closed minutes later; market risk is a
// few cents. Run with BOT_ENABLED paused so the cron doesn't adopt it.
require('dotenv').config({ quiet: true })

const updown = require('../src/exchange/updown')
const { snapshot, oraclePrice, getProvider } = require('../src/exchange/chain-read')
const { log, summary, flushSummary } = require('../src/log')

const SYMBOLS = ['ETH']
const NOTIONAL = 52
const COLLATERAL = 17.5

async function main() {
  let snap = await snapshot(SYMBOLS)
  summary('## Campaign qualifier trade (ETH long, paired TP/SL)')
  summary(`Wallet: CELO ${snap.celoBalance.toFixed(2)}, wUSDT ${snap.wusdtBalance.toFixed(2)}`)
  if (snap.positions.length > 0) throw new Error('Positions already open; aborting')
  if (snap.celoBalance < 8) throw new Error('Need >= 8 CELO for 4 keeper orders')
  if (snap.wusdtBalance < COLLATERAL + 1) throw new Error('Not enough wUSDT')

  const price = await oraclePrice(getProvider(), 'ETH')
  summary(`ETH oracle: ${price}`)

  log(`Opening ETH long ${NOTIONAL} USD notional / ${COLLATERAL} collateral…`)
  const open = await updown.openPosition({
    market: 'ETH',
    isLong: true,
    collateralUsd: COLLATERAL,
    notionalUsd: NOTIONAL,
  })
  summary(`Entry submitted: ${open.txHash}`)

  const pos = await updown.waitForPosition({ market: 'ETH', isLong: true, symbols: SYMBOLS })
  if (!pos) throw new Error('Keeper did not execute entry; run tools/flatten.js to clean up')
  summary(`✅ Position open: ${pos.sizeUsd} USD`)

  const tp = await updown.placeExit({ market: 'ETH', isLong: true, kind: 'tp', triggerPrice: price * 1.015 })
  const sl = await updown.placeExit({ market: 'ETH', isLong: true, kind: 'sl', triggerPrice: price * 0.985 })
  summary(`✅ Paired TP/SL resident on-chain (keys ${String(tp.orderKey).slice(0, 10)}…, ${String(sl.orderKey).slice(0, 10)}…)`)

  // Leave the pair resident briefly, then unwind.
  await new Promise((r) => setTimeout(r, 60000))

  snap = await snapshot(SYMBOLS)
  if (snap.positions.length === 0) {
    summary('TP or SL already executed — round trip complete.')
    flushSummary()
    return
  }
  for (const o of snap.orders) {
    await updown.cancelOrder(o.key)
  }
  summary('TP/SL cancelled (fees refunded)')
  const close = await updown.closeMarket({ market: 'ETH', isLong: true })
  summary(`Close submitted: ${close.txHash}`)

  for (let i = 0; i < 16; i += 1) {
    await new Promise((r) => setTimeout(r, 15000))
    snap = await snapshot(SYMBOLS)
    if (snap.positions.length === 0) {
      summary(`✅ Done. Final: CELO ${snap.celoBalance.toFixed(2)}, wUSDT ${snap.wusdtBalance.toFixed(2)}`)
      flushSummary()
      return
    }
  }
  throw new Error('Position still open — run tools/flatten.js')
}

main().catch((err) => {
  console.error(`Campaign trade failed: ${err.message}`)
  flushSummary()
  process.exitCode = 1
})
