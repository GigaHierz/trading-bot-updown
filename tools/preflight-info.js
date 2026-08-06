// Read-only: protocol minimums and oracle prices, for sizing decisions.
require('dotenv').config({ quiet: true })
const { snapshot } = require('../src/exchange/chain-read')

async function main() {
  const snap = await snapshot(['BTC', 'ETH', 'CELO'])
  console.log(`account: ${snap.account}`)
  console.log(`CELO: ${snap.celoBalance}`)
  console.log(`wUSDT: ${snap.wusdtBalance}`)
  console.log(`MIN_POSITION_SIZE_USD: ${snap.minPositionSizeUsd}`)
  console.log(`oracle prices:`, snap.prices)
  console.log(`positions: ${snap.positions.length}, orders: ${snap.orders.length}`)
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
})
