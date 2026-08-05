#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const addresses = require('../assets/addresses.json')
const markets = require('../assets/markets.json')
const tokenMeta = require('../assets/celo-tokens.json')
const exchangeRouterAbi = require('../assets/abis/ExchangeRouter.json').abi
const dataStoreAbi = require('../assets/abis/DataStore.json').abi
const { getOrder } = require('./lib/order-store')
const { findTokenDecimalsByAddress } = require('./lib/protocol')

function optionalUnits(raw, human, decimals, fallback) {
  if (raw !== undefined && raw !== null) return ethers.BigNumber.from(raw)
  if (human !== undefined && human !== null && String(human).trim() !== '') {
    return ethers.utils.parseUnits(String(human), decimals)
  }
  return fallback
}

async function main(argv = process.argv.slice(2)) {
  const [orderKey, configPath] = argv
  if (!orderKey || !ethers.utils.isHexString(orderKey, 32) || !configPath) {
    throw new Error(
      'Usage: node scripts/update-order.js <order-key> <update-config.json>',
    )
  }
  if (!process.env.CELO_RPC_URL || !process.env.CELO_PRIVATE_KEY) {
    throw new Error('Missing CELO_RPC_URL or CELO_PRIVATE_KEY')
  }

  const cfg = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), configPath), 'utf8'),
  )
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.CELO_RPC_URL,
    {
      chainId: Number(process.env.CELO_CHAIN_ID || 42220),
      name: 'celo',
    },
  )
  const wallet = new ethers.Wallet(process.env.CELO_PRIVATE_KEY, provider)
  const dataStore = new ethers.Contract(
    addresses.celo.DataStore,
    dataStoreAbi,
    provider,
  )
  const current = await getOrder(dataStore, orderKey)
  if (current.account === ethers.constants.AddressZero) {
    throw new Error('Order not found')
  }
  if (current.account.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error('Order belongs to a different wallet')
  }

  const market = markets.find(
    (item) => item.marketToken.toLowerCase() === current.market.toLowerCase(),
  )
  if (!market) throw new Error('Order market is not in assets/markets.json')
  const indexDecimals =
    findTokenDecimalsByAddress(tokenMeta, market.indexToken) ?? 18
  const priceDecimals = 30 - indexDecimals

  const sizeDeltaUsd = optionalUnits(
    cfg.sizeDeltaUsd,
    cfg.sizeDeltaUsdHuman,
    30,
    current.sizeDeltaUsd,
  )
  const acceptablePrice = optionalUnits(
    cfg.acceptablePrice,
    cfg.acceptablePriceHuman,
    priceDecimals,
    current.acceptablePrice,
  )
  const triggerPrice = optionalUnits(
    cfg.triggerPrice,
    cfg.triggerPriceHuman,
    priceDecimals,
    current.triggerPrice,
  )
  const minOutputAmount =
    cfg.minOutputAmount !== undefined
      ? ethers.BigNumber.from(cfg.minOutputAmount)
      : current.minOutputAmount
  const validFromTime =
    cfg.validFromTime !== undefined
      ? ethers.BigNumber.from(cfg.validFromTime)
      : current.validFromTime
  const autoCancel =
    cfg.autoCancel !== undefined ? Boolean(cfg.autoCancel) : current.autoCancel

  const router = new ethers.Contract(
    addresses.celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet,
  )
  const args = [
    orderKey,
    sizeDeltaUsd,
    acceptablePrice,
    triggerPrice,
    minOutputAmount,
    validFromTime,
    autoCancel,
  ]
  console.log(
    JSON.stringify(
      {
        orderKey,
        sizeDeltaUsd: sizeDeltaUsd.toString(),
        acceptablePrice: acceptablePrice.toString(),
        triggerPrice: triggerPrice.toString(),
        minOutputAmount: minOutputAmount.toString(),
        validFromTime: validFromTime.toString(),
        autoCancel,
      },
      null,
      2,
    ),
  )
  await router.callStatic.updateOrder(...args)
  const tx = await router.updateOrder(...args)
  console.log(`updateOrder txHash: ${tx.hash}`)
  console.log(`Explorer: https://celoscan.io/tx/${tx.hash}`)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Update transaction failed')
  console.log(`Order updated in block ${receipt.blockNumber}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { main, optionalUnits }
