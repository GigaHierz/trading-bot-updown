const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const config = require('../config')
const { log } = require('../log')
const { snapshot, marketBySymbol, WUSDT } = require('./chain-read')

const VENDOR = path.join(__dirname, '../../vendor/updown')

// GMX order types used by the bot.
const ORDER_TYPE = {
  MarketIncrease: 2,
  MarketDecrease: 4,
  LimitDecrease: 5, // take-profit
  StopLossDecrease: 6, // stop-loss
}

function runScript(script, args, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(VENDOR, 'scripts', script), ...args],
      {
        cwd: VENDOR,
        env: process.env, // key travels via env only, never argv
        timeout: 5 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${script} failed: ${error.message}\nstdout tail: ${String(stdout).slice(-2000)}\nstderr tail: ${String(stderr).slice(-2000)}`,
            ),
          )
        } else {
          resolve(String(stdout))
        }
      },
    )
    // The vendored open-position script prompts on insufficient allowance.
    // Allowance is pre-approved during setup; this answer is a fallback so a
    // CI run can never hang on the prompt.
    if (stdin) child.stdin.write(stdin)
    child.stdin.end()
  })
}

function writeTmpConfig(cfg) {
  const file = path.join(
    os.tmpdir(),
    `updown-order-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  return file
}

function parseOrderKey(stdout) {
  const m = stdout.match(/orderKey:\s*(0x[0-9a-fA-F]{64})/)
  return m ? m[1] : null
}

function parseTxHash(stdout) {
  const m = stdout.match(/txHash:\s*(0x[0-9a-fA-F]{64})/)
  return m ? m[1] : null
}

async function openPosition({ market, isLong, collateralUsd, notionalUsd }) {
  const cfgFile = writeTmpConfig({
    marketSymbol: `${market}/USDT`,
    isLong,
    orderType: ORDER_TYPE.MarketIncrease,
    sizeDeltaUsdHuman: String(notionalUsd),
    initialCollateralDeltaAmountHuman: String(collateralUsd),
  })
  try {
    const stdout = await runScript('open-position.js', [cfgFile], { stdin: 'yes\n' })
    return { orderKey: parseOrderKey(stdout), txHash: parseTxHash(stdout) }
  } finally {
    fs.unlinkSync(cfgFile)
  }
}

// TP and SL are keeper-resident decrease orders on the full position.
// acceptablePrice must be explicit: for stops we accept a worse fill than the
// trigger so a fast market can still execute.
async function placeExit({ market, isLong, kind, triggerPrice }) {
  const m = marketBySymbol(market)
  const isTp = kind === 'tp'
  const dir = isLong ? 1 : -1
  const acceptable = isTp
    ? triggerPrice * (1 - dir * 0.005)
    : triggerPrice * (1 - dir * 0.03)

  const cfgFile = writeTmpConfig({
    market: m.marketToken,
    indexToken: m.indexToken,
    initialCollateralToken: WUSDT.address,
    isLong,
    closePercent: 100,
    orderType: isTp ? ORDER_TYPE.LimitDecrease : ORDER_TYPE.StopLossDecrease,
    triggerPriceHuman: formatPrice(triggerPrice),
    acceptablePriceHuman: formatPrice(acceptable),
  })
  try {
    const stdout = await runScript('close-position.js', [cfgFile])
    return { orderKey: parseOrderKey(stdout), txHash: parseTxHash(stdout) }
  } finally {
    fs.unlinkSync(cfgFile)
  }
}

async function closeMarket({ market, isLong }) {
  const m = marketBySymbol(market)
  const cfgFile = writeTmpConfig({
    market: m.marketToken,
    indexToken: m.indexToken,
    initialCollateralToken: WUSDT.address,
    isLong,
    closePercent: 100,
    orderType: ORDER_TYPE.MarketDecrease,
  })
  try {
    const stdout = await runScript('close-position.js', [cfgFile])
    return { orderKey: parseOrderKey(stdout), txHash: parseTxHash(stdout) }
  } finally {
    fs.unlinkSync(cfgFile)
  }
}

async function cancelOrder(orderKey) {
  const stdout = await runScript('cancel-order.js', [orderKey])
  return { txHash: parseTxHash(stdout) }
}

// Keeper execution is async; poll until the position shows up on-chain.
async function waitForPosition({ market, isLong, symbols }) {
  const { positionPollAttempts, positionPollDelayMs } = config.risk
  for (let i = 0; i < positionPollAttempts; i += 1) {
    await new Promise((r) => setTimeout(r, positionPollDelayMs))
    const snap = await snapshot(symbols)
    const found = snap.positions.find(
      (p) => p.market === market && p.isLong === isLong,
    )
    if (found) return found
    log(`waiting for keeper to open ${market} ${isLong ? 'long' : 'short'} (${i + 1}/${positionPollAttempts})`)
  }
  return null
}

function formatPrice(value) {
  // Enough precision for BTC down to CELO without float noise.
  return Number(value).toPrecision(8)
}

module.exports = {
  ORDER_TYPE,
  openPosition,
  placeExit,
  closeMarket,
  cancelOrder,
  waitForPosition,
  snapshot,
}
