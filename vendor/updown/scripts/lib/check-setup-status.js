/**
 * Shared setup status for check-setup.js and query.js.
 * Does not POST skillPath / nodeVersion to the backend.
 */

const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
const { reportSetup, getChainId, getSetupReportUrl } = require('./report-trade')

const PLACEHOLDER_KEYS = new Set([
  '',
  '<YOUR_CELO_PRIVATE_KEY>',
  'YOUR_CELO_PRIVATE_KEY',
  '0x',
])

function skillRoot() {
  return path.resolve(__dirname, '../..')
}

function isPlaceholderPrivateKey(value) {
  const v = (value || '').trim().replace(/^['"]|['"]$/g, '')
  if (!v) return true
  if (PLACEHOLDER_KEYS.has(v)) return true
  if (v.includes('YOUR_CELO_PRIVATE_KEY')) return true
  return false
}

function normalizePrivateKey(value) {
  let v = (value || '').trim().replace(/^['"]|['"]$/g, '')
  if (!v) return ''
  if (!v.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(v)) {
    v = `0x${v}`
  }
  return v
}

function checkSetup(options = {}) {
  const root = skillRoot()
  const skillMdPath = path.join(root, 'SKILL.md')
  const envPath = path.join(root, 'assets', 'celo.env.local')
  const exampleEnvPath = path.join(root, 'assets', 'celo.env.example')
  const nodeModulesPath = path.join(root, 'node_modules', 'ethers')

  const installed = fs.existsSync(skillMdPath)
  const envFilePresent = fs.existsSync(envPath)
  const depsInstalled = fs.existsSync(nodeModulesPath)

  const rawKey = process.env.CELO_PRIVATE_KEY
  const privateKey = normalizePrivateKey(rawKey)
  const rpcConfigured = Boolean((process.env.CELO_RPC_URL || '').trim())
  const reportApiConfigured = Boolean(getSetupReportUrl())

  let walletConfigured = false
  let address = options.addressHint || null
  let walletError = null

  if (!isPlaceholderPrivateKey(privateKey)) {
    try {
      const wallet = new ethers.Wallet(privateKey)
      address = wallet.address
      walletConfigured = true
    } catch (err) {
      walletError = err.message
      walletConfigured = false
      if (!options.addressHint) address = null
    }
  } else if (options.addressHint) {
    // Caller already opened a wallet (e.g. query.js) — treat as configured.
    address = options.addressHint
    walletConfigured = true
  }

  return {
    installed,
    walletConfigured,
    address,
    chainId: getChainId(),
    skillName: 'updown',
    skillPath: root,
    envFilePresent,
    envExamplePresent: fs.existsSync(exampleEnvPath),
    depsInstalled,
    rpcConfigured,
    reportApiConfigured,
    nodeVersion: process.version,
    createdAt: new Date().toISOString(),
    walletError,
  }
}

/** Payload for POST /gt/trade/skill/setup (no skillPath / nodeVersion). */
function buildSetupReportPayload(status) {
  return {
    installed: status.installed,
    walletConfigured: status.walletConfigured,
    account: status.address,
    address: status.address,
    skillName: status.skillName,
    envFilePresent: status.envFilePresent,
    depsInstalled: status.depsInstalled,
    rpcConfigured: status.rpcConfigured,
    reportApiConfigured: status.reportApiConfigured,
    walletError: status.walletError,
  }
}

/**
 * Build setup status and POST to backend.
 * Failures are logged only; never throws into the caller flow.
 */
async function reportSetupStatus(options = {}) {
  try {
    const status = checkSetup(options)
    return await reportSetup(buildSetupReportPayload(status))
  } catch (err) {
    console.error('[report-setup] ❌', err.message)
    return { ok: false, error: err.message }
  }
}

module.exports = {
  checkSetup,
  buildSetupReportPayload,
  reportSetupStatus,
  skillRoot,
}
