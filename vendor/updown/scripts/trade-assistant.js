#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const markets = require('../assets/markets.json')
const tokenMeta = require('../assets/celo-tokens.json')
const {
  generateOrderConfig,
  generateTwapConfigs,
  parseUserInput,
} = require('./lib/trade-intent')

const HELP_MESSAGE = `
UPDOWN trade assistant

Generate one action at a time:
  node scripts/trade-assistant.js "Open BTC/USDT long market with 10 USDT margin and 2x leverage"
  node scripts/trade-assistant.js "Open EURm/USDT short limit at 1.1 with 10 USDT margin"
  node scripts/trade-assistant.js "Close 50% of BTC/USDT long"
  node scripts/trade-assistant.js "Set stop-loss for BTC/USDT long at 60000"
  node scripts/trade-assistant.js "TWAP open NGNm/USDT long with 20 USDT margin in 4 parts over 30 minutes"
  node scripts/trade-assistant.js "List my orders"

Safety behavior:
  - Ambiguous, multi-leg, conditional, negative, or incomplete instructions fail closed.
  - Default limits are 20x leverage and 100,000 USD notional; override with
    UPDOWN_MAX_LEVERAGE and UPDOWN_MAX_NOTIONAL_USD.
  - Generated files never contain a private key and do not submit a transaction.
`

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function saveConfig(config, parsed, suffix = '') {
  const ordersDir = path.join(__dirname, '../orders')
  fs.mkdirSync(ordersDir, { recursive: true })
  const name = [
    'order',
    parsed.action,
    slug(parsed.market),
    parsed.isLong ? 'long' : 'short',
    suffix,
  ]
    .filter(Boolean)
    .join('-')
  const fileName = `${name}.json`
  fs.writeFileSync(
    path.join(ordersDir, fileName),
    `${JSON.stringify(config, null, 2)}\n`,
  )
  return fileName
}

function executionCommand(parsed, fileName) {
  return parsed.action === 'open'
    ? `node scripts/open-position.js orders/${fileName}`
    : `node scripts/close-position.js orders/${fileName}`
}

async function main(argv = process.argv.slice(2)) {
  const input = argv.join(' ').trim()
  if (!input || input === '--help' || input === '-h') {
    console.log(HELP_MESSAGE)
    return
  }

  const parsed = parseUserInput(input, markets)
  console.log('Parsed intent:')
  console.log(JSON.stringify(parsed, null, 2))

  if (parsed.action === 'query') {
    execFileSync(process.execPath, [path.join(__dirname, 'query.js'), parsed.queryType], {
      stdio: 'inherit',
    })
    return
  }

  const baseConfig = generateOrderConfig(parsed, markets, tokenMeta)
  if (parsed.orderType === 'twap') {
    const configs = generateTwapConfigs(parsed, baseConfig)
    const files = configs.map((config, index) =>
      saveConfig(config, parsed, `twap-part-${index + 1}-of-${configs.length}`),
    )
    console.log(`Generated ${files.length} TWAP configs:`)
    files.forEach((file) => console.log(`  orders/${file}`))
    console.log(
      `Run: node scripts/send-twap-multicall.js "${slug(parsed.market)}"`,
    )
    return
  }

  const fileName = saveConfig(baseConfig, parsed)
  console.log('Generated config:')
  console.log(JSON.stringify(baseConfig, null, 2))
  console.log(`Saved: orders/${fileName}`)
  console.log(`Run: ${executionCommand(parsed, fileName)}`)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = { HELP_MESSAGE, main }
