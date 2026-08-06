// Prints the protocol's own execution-fee estimate (buffered) per order type,
// to sanity-check the script-level 1.4 CELO fallback floor.
require('dotenv').config({ quiet: true })
const path = require('path')
const { ethers } = require('ethers')

const VENDOR = path.join(__dirname, '../vendor/updown')
const addresses = require(path.join(VENDOR, 'assets/addresses.json')).celo
const dataStoreAbi = require(path.join(VENDOR, 'assets/abis/DataStore.json')).abi
const { estimateExecutionFee } = require(path.join(VENDOR, 'scripts/lib/protocol'))
const { getProvider } = require('../src/exchange/chain-read')

async function main() {
  const provider = getProvider()
  const dataStore = new ethers.Contract(addresses.DataStore, dataStoreAbi, provider)
  const gasPrice = await provider.getGasPrice()
  console.log(`gasPrice: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei`)
  for (const key of ['INCREASE_ORDER_GAS_LIMIT', 'DECREASE_ORDER_GAS_LIMIT']) {
    const fee = await estimateExecutionFee({
      dataStore,
      provider,
      gasLimitKey: key,
      swapCount: 0,
      oraclePriceCount: 3,
    })
    const buffered = fee.mul(12500).add(9999).div(10000)
    console.log(
      `${key}: estimate ${ethers.utils.formatEther(fee)} CELO, ×1.25 buffer ${ethers.utils.formatEther(buffered)} CELO`,
    )
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
})
