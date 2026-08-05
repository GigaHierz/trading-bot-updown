#!/usr/bin/env node

const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const addresses = require('../assets/addresses.json')
const readerAbi = require('../assets/abis/Reader.json').abi
const dataStoreAbi = require('../assets/abis/DataStore.json').abi
const markets = require('../assets/markets.json')
const tokenMeta = require('../assets/celo-tokens.json')
const { reportSetupStatus } = require('./lib/check-setup-status')
const { getAccountOrders } = require('./lib/order-store')
const {
  findTokenDecimalsByAddress,
} = require('./lib/protocol')

const ERC20_VIEW_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]
const NATIVE_USDT = {
  symbol: 'USDT (native)',
  address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e',
  decimals: 6,
}
const ORDER_TYPES = [
  'MarketSwap',
  'LimitSwap',
  'MarketIncrease',
  'LimitIncrease',
  'MarketDecrease',
  'LimitDecrease',
  'StopLossDecrease',
  'Liquidation',
  'StopIncrease',
]

function normalizeAddress(value) {
  return String(value || '').toLowerCase()
}

function marketInfo(address) {
  return (
    markets.find(
      (market) =>
        normalizeAddress(market.marketToken) === normalizeAddress(address),
    ) || null
  )
}

function tokenInfo(address) {
  const entry = Object.values(tokenMeta).find(
    (token) => normalizeAddress(token.address) === normalizeAddress(address),
  )
  return entry || null
}

async function printBalances(provider, account) {
  console.log('\n=== Wallet balances ===')
  const celo = await provider.getBalance(account)
  console.log(`CELO (native): ${ethers.utils.formatEther(celo)}`)

  for (const info of [...Object.values(tokenMeta), NATIVE_USDT]) {
    const token = new ethers.Contract(info.address, ERC20_VIEW_ABI, provider)
    try {
      const balance = await token.balanceOf(account)
      console.log(
        `${info.symbol}: ${ethers.utils.formatUnits(balance, info.decimals)}`,
      )
    } catch (error) {
      console.log(`${info.symbol}: unavailable (${error.message})`)
    }
  }
}

async function printPositions(reader, account) {
  const positions = await reader.getAccountPositions(
    addresses.celo.DataStore,
    account,
    0,
    50,
  )
  const active = positions.filter((position) =>
    ethers.BigNumber.from(position.numbers.sizeInUsd || 0).gt(0),
  )

  console.log(`\n=== Positions (${active.length}) ===`)
  for (const [index, position] of active.entries()) {
    const market = marketInfo(position.addresses.market)
    const collateral = tokenInfo(position.addresses.collateralToken)
    const decimals = collateral ? collateral.decimals : 18
    console.log(`\n#${index + 1} ${market ? `${market.indexTokenSymbol}/${market.shortTokenSymbol}` : position.addresses.market}`)
    console.log(`Side: ${position.flags.isLong ? 'long' : 'short'}`)
    console.log(
      `Size: ${ethers.utils.formatUnits(position.numbers.sizeInUsd, 30)} USD`,
    )
    console.log(
      `Collateral: ${ethers.utils.formatUnits(
        position.numbers.collateralAmount,
        decimals,
      )} ${collateral ? collateral.symbol : position.addresses.collateralToken}`,
    )
  }
}

async function printOrders(dataStore, account) {
  const orders = await getAccountOrders(dataStore, account, 0, 50)
  console.log(`\n=== Pending orders (${orders.length}) ===`)
  for (const [index, order] of orders.entries()) {
    const market = marketInfo(order.market)
    const indexDecimals = market
      ? findTokenDecimalsByAddress(tokenMeta, market.indexToken) ?? 18
      : 18
    const priceDecimals = 30 - indexDecimals
    console.log(`\n#${index + 1} ${order.key}`)
    console.log(
      `Market: ${market ? `${market.indexTokenSymbol}/${market.shortTokenSymbol}` : order.market}`,
    )
    console.log(`Type: ${ORDER_TYPES[order.orderType] || order.orderType}`)
    console.log(`Side: ${order.isLong ? 'long' : 'short'}`)
    console.log(
      `Size: ${ethers.utils.formatUnits(order.sizeDeltaUsd, 30)} USD`,
    )
    if (!order.triggerPrice.isZero()) {
      console.log(
        `Trigger: ${ethers.utils.formatUnits(order.triggerPrice, priceDecimals)}`,
      )
    }
    console.log(`Execution fee: ${ethers.utils.formatEther(order.executionFee)} CELO`)
    console.log(
      `Cancel: node scripts/cancel-order.js ${order.key}`,
    )
  }
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'positions'
  if (!['positions', 'balance', 'orders'].includes(command)) {
    throw new Error(
      'Usage: node scripts/query.js <positions|balance|orders>',
    )
  }
  if (!process.env.CELO_RPC_URL || !process.env.CELO_PRIVATE_KEY) {
    throw new Error('Missing CELO_RPC_URL or CELO_PRIVATE_KEY')
  }

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.CELO_RPC_URL,
    {
      chainId: Number(process.env.CELO_CHAIN_ID || 42220),
      name: 'celo',
    },
  )
  const wallet = new ethers.Wallet(process.env.CELO_PRIVATE_KEY, provider)
  const reader = new ethers.Contract(addresses.celo.Reader, readerAbi, provider)
  const dataStore = new ethers.Contract(
    addresses.celo.DataStore,
    dataStoreAbi,
    provider,
  )

  console.log(`Wallet: ${wallet.address}`)
  if (command === 'positions') {
    await printPositions(reader, wallet.address)
    await printBalances(provider, wallet.address)
  } else if (command === 'balance') {
    await printBalances(provider, wallet.address)
  } else {
    await printOrders(dataStore, wallet.address)
  }

  await reportSetupStatus({ addressHint: wallet.address })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  main,
  marketInfo,
  printBalances,
  printOrders,
  printPositions,
  tokenInfo,
}
