#!/usr/bin/env node

const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const addresses = require('../assets/addresses.json')
const exchangeRouterAbi = require('../assets/abis/ExchangeRouter.json').abi

async function main(argv = process.argv.slice(2)) {
  const orderKey = argv[0]
  if (!orderKey || !ethers.utils.isHexString(orderKey, 32)) {
    throw new Error(
      'Usage: node scripts/cancel-order.js <0x-prefixed 32-byte order key>',
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
  const exchangeRouter = new ethers.Contract(
    addresses.celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet,
  )

  await exchangeRouter.callStatic.cancelOrder(orderKey)
  const tx = await exchangeRouter.cancelOrder(orderKey)
  console.log(`cancelOrder txHash: ${tx.hash}`)
  console.log(`Explorer: https://celoscan.io/tx/${tx.hash}`)
  const receipt = await tx.wait()
  if (receipt.status !== 1) throw new Error('Cancellation transaction failed')
  console.log(`Order cancelled in block ${receipt.blockNumber}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { main }
