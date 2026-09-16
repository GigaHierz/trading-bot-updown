// Multi-month candle history for the backtest.
//
// src/data/candles.js caps at config.candles.limit (120) bars because that is
// all a live run needs. The backtest needs months, so this paginates Binance
// klines and caches to disk. It reuses BINANCE_HOSTS/fetchJson from the live
// module rather than forking the host-fallback logic.

const fs = require('fs')
const path = require('path')
const config = require('../config')
const { BINANCE_HOSTS, fetchJson } = require('../data/candles')

const INTERVAL_MS = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000,
}

const CACHE_DIR = path.join(__dirname, '../../.cache/candles')

function intervalMs(interval) {
  const ms = INTERVAL_MS[interval]
  if (!ms) throw new Error(`Unsupported interval: ${interval}`)
  return ms
}

function cachePath(market, interval) {
  return path.join(CACHE_DIR, `${market}-${interval}.json`)
}

function readCache(market, interval) {
  const file = cachePath(market, interval)
  if (!fs.existsSync(file)) return []
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (raw.bars || []).map(([t, o, h, l, c]) => ({ t, o, h, l, c }))
}

function writeCache(market, interval, bars) {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  fs.writeFileSync(
    cachePath(market, interval),
    JSON.stringify({
      market,
      interval,
      bars: bars.map((b) => [b.t, b.o, b.h, b.l, b.c]),
    }),
  )
}

// Closed bars are immutable, so merging by timestamp is safe.
function mergeBars(a, b) {
  const by = new Map()
  for (const bar of [...a, ...b]) by.set(bar.t, bar)
  return [...by.values()].sort((x, y) => x.t - y.t)
}

async function fetchKlines({ market, interval, startMs, endMs }) {
  const symbol = config.candles.binanceSymbols[market]
  if (!symbol) throw new Error(`No Binance symbol for market ${market}`)
  const step = intervalMs(interval)
  const out = []
  let cursor = startMs

  while (cursor < endMs) {
    const qs =
      `symbol=${symbol}&interval=${interval}&limit=1000&startTime=${Math.floor(cursor)}`
    let page = null
    let lastErr = null
    for (const host of BINANCE_HOSTS) {
      try {
        page = await fetchJson(`${host}/api/v3/klines?${qs}`)
        break
      } catch (err) {
        lastErr = err
      }
    }
    if (!page) throw new Error(`Binance klines failed for ${market} ${interval}: ${lastErr?.message}`)
    if (!page.length) break

    const bars = page.map((k) => ({
      t: k[0],
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
    }))
    // The final bar of a page may still be open; drop it and refetch next loop.
    const closed = bars.filter((b) => b.t + step <= Date.now())
    out.push(...closed)
    if (page.length < 1000) break
    const next = bars[bars.length - 1].t + step
    if (next <= cursor) break
    cursor = next
  }
  return out.filter((b) => b.t >= startMs && b.t < endMs)
}

async function loadHistory({ market, interval, from, to, offline = false }) {
  const startMs = new Date(from).getTime()
  const endMs = new Date(to).getTime()
  const cached = readCache(market, interval)
  const covers =
    cached.length &&
    cached[0].t <= startMs &&
    cached[cached.length - 1].t >= endMs - intervalMs(interval) * 2

  if (covers) return cached.filter((b) => b.t >= startMs && b.t < endMs)
  if (offline) {
    throw new Error(
      `--offline: no cached ${market} ${interval} history covering ${from}..${to}. ` +
        'Run `node tools/backtest.js --fetch-only` first.',
    )
  }

  const fetched = await fetchKlines({ market, interval, startMs, endMs })
  const merged = mergeBars(cached, fetched)
  writeCache(market, interval, merged)
  return merged.filter((b) => b.t >= startMs && b.t < endMs)
}

// What the bot can see at wall-clock T.
//
// Live getCandles always returns an array whose LAST element is the bar
// currently in progress; closedBars() then drops it. To reproduce that exactly,
// include every bar whose open is <= T (which is the in-progress bar at T) and
// then truncate to config.candles.limit.
//
// The limit is not cosmetic. reconcileSim can only fill from bars still inside
// the window, so a position held longer than `limit` bars genuinely cannot be
// filled by the live bot either. Dropping the cap makes the backtest optimistic
// in a way that is invisible in the output.
function sliceHistory(bars, T, limit = config.candles.limit) {
  let hi = bars.length
  let lo = 0
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].t <= T) lo = mid + 1
    else hi = mid
  }
  const visible = bars.slice(0, lo)
  return visible.length > limit ? visible.slice(visible.length - limit) : visible
}

module.exports = { fetchKlines, loadHistory, sliceHistory, intervalMs, CACHE_DIR, INTERVAL_MS }
