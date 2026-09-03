// Measures the UPDOWN (Chainlink) oracle min/max vs Binance spot per market.
// GMX-style fills use the worse side (long opens at max, short at min), so the
// tradable edge is vs min/max, not vs mid.
require('dotenv').config({ quiet: true })
const path = require('path')
const { ethers } = require('ethers')

const VENDOR = path.join(__dirname, '../vendor/updown')
const addresses = require(path.join(VENDOR, 'assets/addresses.json')).celo
const tokenMeta = require(path.join(VENDOR, 'assets/celo-tokens.json'))
const abi = require(path.join(VENDOR, 'assets/abis/ChainlinkPriceFeedProvider.json')).abi
const { getProvider, marketBySymbol } = require('../src/exchange/chain-read')
const config = require('../src/config')

async function main() {
  const provider = getProvider()
  const feed = new ethers.Contract(addresses.ChainlinkPriceFeedProvider, abi, provider)

  for (const symbol of ['BTC', 'ETH', 'CELO']) {
    const m = marketBySymbol(symbol)
    const dec = 30 - Number(tokenMeta[symbol].decimals)
    const p = await feed.getOraclePrice(m.indexToken, '0x')
    const min = Number(ethers.utils.formatUnits(p.min, dec))
    const max = Number(ethers.utils.formatUnits(p.max, dec))
    const b = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${config.candles.binanceSymbols[symbol]}`,
    ).then((r) => r.json())
    const spot = Number(b.price)
    const pct = (x) => (((x - spot) / spot) * 100).toFixed(3) + '%'
    console.log(
      `${symbol}: oracle min ${min} (${pct(min)}) max ${max} (${pct(max)}) | binance ${spot} | oracle spread ${((max / min - 1) * 100).toFixed(3)}%`,
    )
  }
}

main().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
