#!/usr/bin/env node
/**
 * Read market list from chain and update local config files.
 */

const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const addresses = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/addresses.json'), 'utf8'),
)

// Reader ABI - includes getMarkets
const readerAbi = [
  'function getMarkets(address dataStore, uint256 start, uint256 end) view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken)[])',
]

const erc20Abi = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]

async function fetchMarketsFromChain(provider) {
  const reader = new ethers.Contract(addresses.celo.Reader, readerAbi, provider)

  console.log('Reading market list from chain...\n')

  const pageSize = 50
  let start = 0
  const allMarkets = []

  while (true) {
    const end = start + pageSize
    try {
      const markets = await reader.getMarkets(
        addresses.celo.DataStore,
        start,
        end,
      )

      if (!markets || markets.length === 0) {
        break
      }

      for (const m of markets) {
        allMarkets.push({
          marketToken: m.marketToken,
          indexToken: m.indexToken,
          longToken: m.longToken,
          shortToken: m.shortToken,
        })
      }

      console.log(`Read ${markets.length} markets (range ${start}-${end})`)

      if (markets.length < pageSize) {
        break
      }

      start = end
    } catch (err) {
      console.log(`Read failed: ${err.message}`)
      break
    }
  }

  console.log(`\nTotal markets fetched: ${allMarkets.length}\n`)
  return allMarkets
}

async function enrichMarketData(markets, provider) {
  console.log('Fetching token symbols and decimals...\n')

  const enriched = []
  const tokenMeta = {} // collected token metadata

  for (const m of markets) {
    try {
      const indexToken = new ethers.Contract(m.indexToken, erc20Abi, provider)
      const longToken = new ethers.Contract(m.longToken, erc20Abi, provider)
      const shortToken = new ethers.Contract(m.shortToken, erc20Abi, provider)

      const [
        indexSymbol,
        longSymbol,
        shortSymbol,
        indexDecimals,
        longDecimals,
        shortDecimals,
      ] = await Promise.all([
        indexToken.symbol().catch(() => 'UNKNOWN'),
        longToken.symbol().catch(() => 'UNKNOWN'),
        shortToken.symbol().catch(() => 'UNKNOWN'),
        indexToken.decimals().catch(() => 18),
        longToken.decimals().catch(() => 18),
        shortToken.decimals().catch(() => 6),
      ])

      const cleanIndexSymbol = indexSymbol
        .replace(/[^a-zA-Z0-9]/g, 'T')
        .replace(/^w/, '')
      const cleanLongSymbol = longSymbol
        .replace(/[^a-zA-Z0-9]/g, 'T')
        .replace(/^w/, '')
      const cleanShortSymbol = shortSymbol
        .replace(/[^a-zA-Z0-9]/g, 'T')
        .replace(/^w/, '')

      enriched.push({
        marketToken: m.marketToken,
        indexToken: m.indexToken,
        longToken: m.longToken,
        shortToken: m.shortToken,
        indexTokenSymbol: cleanIndexSymbol,
        longTokenSymbol: cleanLongSymbol,
        shortTokenSymbol: cleanShortSymbol,
      })

      // Collect token info
      tokenMeta[cleanIndexSymbol] = {
        address: m.indexToken,
        decimals: indexDecimals,
      }
      tokenMeta[cleanLongSymbol] = {
        address: m.longToken,
        decimals: longDecimals,
      }
      tokenMeta[cleanShortSymbol] = {
        address: m.shortToken,
        decimals: shortDecimals,
      }

      console.log(`✓ ${cleanIndexSymbol}/USDT`)
    } catch (err) {
      console.log(
        `✗ Market ${m.marketToken.slice(0, 10)}... read failed: ${err.message}`,
      )
      enriched.push({
        marketToken: m.marketToken,
        indexToken: m.indexToken,
        longToken: m.longToken,
        shortToken: m.shortToken,
        indexTokenSymbol: 'UNKNOWN',
        longTokenSymbol: 'UNKNOWN',
        shortTokenSymbol: 'UNKNOWN',
      })
    }
  }

  return { enriched, tokenMeta }
}

async function main() {
  console.log('=== Update markets from chain ===\n')

  const rpcUrl = process.env.CELO_RPC_URL
  if (!rpcUrl) {
    console.error('Error: missing CELO_RPC_URL in env')
    process.exit(1)
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || '42220'),
    name: 'celo',
  })

  const chainMarkets = await fetchMarketsFromChain(provider)

  if (chainMarkets.length === 0) {
    console.log('Unable to read market list from chain, using existing config\n')
    console.log('Falling back to existing markets.json\n')
    return
  }

  const { enriched: enrichedMarkets, tokenMeta } = await enrichMarketData(
    chainMarkets,
    provider,
  )

  const marketsPath = path.join(__dirname, '../assets/markets.json')
  const tokensPath = path.join(__dirname, '../assets/celo-tokens.json')
  const backupPath = path.join(
    __dirname,
    `../assets/markets.json.backup.${Date.now()}`,
  )
  const tokensBackupPath = path.join(
    __dirname,
    `../assets/celo-tokens.json.backup.${Date.now()}`,
  )

  if (fs.existsSync(marketsPath)) {
    fs.copyFileSync(marketsPath, backupPath)
    console.log(`\nBacked up markets.json to: ${backupPath}`)
  }

  if (fs.existsSync(tokensPath)) {
    fs.copyFileSync(tokensPath, tokensBackupPath)
    console.log(`Backed up celo-tokens.json to: ${tokensBackupPath}\n`)
  }

  fs.writeFileSync(marketsPath, JSON.stringify(enrichedMarkets, null, 2))
  console.log(`✅ Updated market list, total ${enrichedMarkets.length} markets`)

  fs.writeFileSync(tokensPath, JSON.stringify(tokenMeta, null, 2))
  console.log(
    `✅ Updated token list, total ${Object.keys(tokenMeta).length} tokens\n`,
  )

  console.log('=== Updated market list ===\n')
  enrichedMarkets.forEach((m, i) => {
    console.log(`${i + 1}. ${m.indexTokenSymbol}/USDT`)
    console.log(`   Market: ${m.marketToken}`)
    console.log(`   Index: ${m.indexTokenSymbol} (${m.indexToken})`)
    console.log(`   Long: ${m.longTokenSymbol} (${m.longToken})`)
    console.log(`   Short: ${m.shortTokenSymbol} (${m.shortToken})`)
    console.log('')
  })
}

main().catch(console.error)
