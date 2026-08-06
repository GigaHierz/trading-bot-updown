// Emergency/cleanup: cancel every resident order and market-close every open
// position in the wallet. Prints what it does; safe to re-run.
require('dotenv').config({ quiet: true })

const updown = require('../src/exchange/updown')
const { snapshot } = require('../src/exchange/chain-read')

const SYMBOLS = ['BTC', 'ETH', 'CELO']

async function main() {
  let snap = await snapshot(SYMBOLS)
  console.log(`positions: ${snap.positions.length}, orders: ${snap.orders.length}`)

  for (const o of snap.orders) {
    console.log(`cancelling order ${o.key.slice(0, 12)}… (type ${o.orderType} ${o.market})`)
    await updown.cancelOrder(o.key)
  }

  for (const p of snap.positions) {
    console.log(`closing ${p.market} ${p.isLong ? 'long' : 'short'} (${p.sizeUsd} USD)…`)
    await updown.closeMarket({ market: p.market, isLong: p.isLong })
  }

  if (snap.positions.length > 0) {
    for (let i = 0; i < 16; i += 1) {
      await new Promise((r) => setTimeout(r, 15000))
      snap = await snapshot(SYMBOLS)
      if (snap.positions.length === 0) break
      console.log(`waiting for keeper… positions left: ${snap.positions.length}`)
    }
  }

  snap = await snapshot(SYMBOLS)
  console.log(
    `done. positions: ${snap.positions.length}, orders: ${snap.orders.length}, ` +
      `CELO ${snap.celoBalance.toFixed(2)}, wUSDT ${snap.wusdtBalance.toFixed(2)}`,
  )
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
})
