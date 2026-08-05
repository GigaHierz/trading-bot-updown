#!/usr/bin/env node
/**
 * Check whether updown skill is installed and whether a wallet (private key) is configured.
 *
 * Usage:
 *   node scripts/check-setup.js
 *   node scripts/check-setup.js --json
 *   node scripts/check-setup.js --no-report
 *
 * Env (assets/celo.env.local):
 *   CELO_PRIVATE_KEY, CELO_RPC_URL, CELO_CHAIN_ID
 *   TRADE_REPORT_API_URL / TRADE_SETUP_API_URL / TRADE_REPORT_API_KEY
 *
 * Default: print status and POST to Java /gt/trade/skill/setup when URL is configured.
 */

const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const {
  checkSetup,
  buildSetupReportPayload,
} = require('./lib/check-setup-status')
const { reportSetup } = require('./lib/report-trade')

function printHuman(status) {
  console.log('\n=== updown skill setup check ===\n')
  console.log(`installed:          ${status.installed ? 'yes' : 'no'}`)
  console.log(`walletConfigured:   ${status.walletConfigured ? 'yes' : 'no'}`)
  console.log(`address:            ${status.address || '(none)'}`)
  console.log(`chainId:            ${status.chainId}`)
  console.log(`skillPath:          ${status.skillPath}`)
  console.log(`envFilePresent:     ${status.envFilePresent ? 'yes' : 'no'}`)
  console.log(`depsInstalled:      ${status.depsInstalled ? 'yes' : 'no'}`)
  console.log(`rpcConfigured:      ${status.rpcConfigured ? 'yes' : 'no'}`)
  console.log(
    `reportApiConfigured:${status.reportApiConfigured ? 'yes' : 'no'}`,
  )
  if (status.walletError) {
    console.log(`walletError:        ${status.walletError}`)
  }
  console.log('')
}

async function main() {
  const args = process.argv.slice(2)
  const jsonOnly = args.includes('--json')
  const noReport = args.includes('--no-report')

  const status = checkSetup()

  if (jsonOnly) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    printHuman(status)
    console.log('JSON:')
    console.log(JSON.stringify(status, null, 2))
  }

  if (!noReport) {
    const result = await reportSetup(buildSetupReportPayload(status))
    if (!jsonOnly) {
      console.log('\nreport result:', JSON.stringify(result))
    } else if (result && !result.skipped) {
      console.error('[check-setup] report:', JSON.stringify(result))
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
