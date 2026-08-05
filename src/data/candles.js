const config = require('../config')
const { warn } = require('../log')

const BINANCE_HOSTS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api-gcp.binance.com',
]

async function fetchJson(url, timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

async function fromBinance(market, interval, limit) {
  const symbol = config.candles.binanceSymbols[market]
  let lastError
  for (const host of BINANCE_HOSTS) {
    try {
      const rows = await fetchJson(
        `${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      )
      return rows.map((r) => ({
        t: r[0],
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
      }))
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function fromOkx(market, interval, limit) {
  const instId = config.candles.okxInstIds[market]
  const bar = interval === '1h' ? '1H' : interval === '4h' ? '4H' : interval
  const res = await fetchJson(
    `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(limit, 300)}`,
  )
  if (res.code !== '0') throw new Error(`OKX error ${res.code}: ${res.msg}`)
  // OKX returns newest first.
  return res.data
    .map((r) => ({
      t: Number(r[0]),
      o: Number(r[1]),
      h: Number(r[2]),
      l: Number(r[3]),
      c: Number(r[4]),
    }))
    .reverse()
}

// Returns candles oldest→newest. The last element may be an unfinished bar;
// strategies must operate on closed bars only.
async function getCandles(market, interval, limit = config.candles.limit) {
  try {
    return await fromBinance(market, interval, limit)
  } catch (err) {
    warn(`Binance candles failed for ${market} ${interval}: ${err.message}; trying OKX`)
    return await fromOkx(market, interval, limit)
  }
}

// Drop the in-progress bar: the final kline covers "now" and is not closed.
function closedBars(candles) {
  return candles.slice(0, -1)
}

module.exports = { getCandles, closedBars }
