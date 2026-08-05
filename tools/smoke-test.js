// Funded smoke test: one tiny CELO/USDT round trip to prove the whole pipe —
// entry order, keeper execution, TP/SL placement, cancel, market close.
// Run manually (or via workflow_dispatch with smoke=true) AFTER the wallet is
// funded and tools/approve.js has been run. Costs a few cents in fees.
require('dotenv').config({ quiet: true })

const updown = require('../src/exchange/updown')
const { snapshot, oraclePrice, getProvider } = require('../src/exchange/chain-read')
const { log, summary, flushSummary } = require('../src/log')

const SYMBOLS = ['CELO']

async function main() {
  const snap = await snapshot(SYMBOLS)
  summary('## Smoke test (CELO/USDT 1x round trip)')
  summary(`Wallet: CELO ${snap.celoBalance.toFixed(2)}, wUSDT ${snap.wusdtBalance.toFixed(2)}`)
  if (snap.celoBalance < 5) throw new Error('Need >= 5 CELO for execution fees')
  if (snap.wusdtBalance < 10) throw new Error('Need >= 10 wUSDT collateral')
  if (snap.positions.length > 0) throw new Error('Wallet already has positions; aborting')
  if (snap.minPositionSizeUsd !== null) {
    summary(`Protocol MIN_POSITION_SIZE_USD: ${snap.minPositionSizeUsd}`)
    if (snap.minPositionSizeUsd > 10) {
      throw new Error(`Protocol minimum ${snap.minPositionSizeUsd} > 10 USD test size — adjust config`)
    }
  }

  const price = await oraclePrice(getProvider(), 'CELO').catch(() => snap.prices.CELO)
  summary(`CELO oracle price: ${price}`)

  log('Opening 10 USD notional CELO long (1x)…')
  const open = await updown.openPosition({
    market: 'CELO',
    isLong: true,
    collateralUsd: 10,
    notionalUsd: 10,
  })
  summary(`Entry order submitted: ${open.txHash}`)

  const pos = await updown.waitForPosition({ market: 'CELO', isLong: true, symbols: SYMBOLS })
  if (!pos) throw new Error('Keeper did not execute the entry within the poll window')
  summary(`✅ Position open: ${pos.sizeUsd} USD, collateral ${pos.collateralUsd} wUSDT`)

  log('Placing far TP/SL to test exit orders…')
  const tp = await updown.placeExit({ market: 'CELO', isLong: true, kind: 'tp', triggerPrice: price * 1.5 })
  const sl = await updown.placeExit({ market: 'CELO', isLong: true, kind: 'sl', triggerPrice: price * 0.5 })
  summary(`✅ TP + SL placed`)

  log('Cancelling TP/SL again…')
  await updown.cancelOrder(tp.orderKey)
  await updown.cancelOrder(sl.orderKey)
  summary('✅ TP + SL cancelled (execution fees refunded)')

  log('Closing position at market…')
  const close = await updown.closeMarket({ market: 'CELO', isLong: true })
  summary(`Close order submitted: ${close.txHash}`)

  for (let i = 0; i < 16; i += 1) {
    await new Promise((r) => setTimeout(r, 15000))
    const s = await snapshot(SYMBOLS)
    if (s.positions.length === 0) {
      summary(`✅ Round trip complete. Final: CELO ${s.celoBalance.toFixed(2)}, wUSDT ${s.wusdtBalance.toFixed(2)}`)
      flushSummary()
      return
    }
  }
  throw new Error('Position still open after close — check Celoscan / cancel manually')
}

main().catch((err) => {
  console.error(`Smoke test failed: ${err.message}`)
  flushSummary()
  process.exitCode = 1
})
