const config = require('../config')
const { ema, donchianHigh, donchianLow } = require('./indicators')
const { closedBars } = require('../data/candles')
const { entriesToday } = require('../state/store')

// Momentum breakout on 1h bars. Long: EMA(fast) > EMA(slow) AND the last
// closed bar breaks the prior Donchian high. Short is the mirror.
// Emits at most one open intent per run.
function tick({ candlesByMarket, sleeve, now }) {
  const cfg = config.sleeves.A
  const intents = []

  const openMarkets = Object.keys(sleeve.positions)
  if (sleeve.halted) return intents

  for (const market of config.sleeveMarkets.A) {
    const position = sleeve.positions[market]

    if (position) {
      const ageHours = (now - new Date(position.openedAt)) / 3.6e6
      if (position.status === 'open' && ageHours > cfg.timeStopHours) {
        intents.push({
          kind: 'close',
          sleeve: 'A',
          market,
          reason: `time-stop after ${Math.round(ageHours)}h`,
        })
      }
      continue
    }

    if (openMarkets.length >= cfg.maxConcurrentPositions) continue
    if (entriesToday(sleeve, now) >= cfg.maxEntriesPerDay) continue

    const bars = closedBars(candlesByMarket[market] || [])
    if (bars.length < cfg.emaSlow + cfg.donchian) continue

    const closes = bars.map((b) => b.c)
    const last = bars[bars.length - 1]
    if (sleeve.lastSignalBar[market] === last.t) continue

    const fast = ema(closes, cfg.emaFast)
    const slow = ema(closes, cfg.emaSlow)
    const upper = donchianHigh(bars, cfg.donchian)
    const lower = donchianLow(bars, cfg.donchian)
    if (fast === null || slow === null || upper === null || lower === null) continue

    let isLong = null
    if (fast > slow && last.c > upper) isLong = true
    else if (fast < slow && last.c < lower) isLong = false
    if (isLong === null) continue

    const collateralUsd = Math.min(
      sleeve.equity * cfg.equityFractionPerTrade,
      cfg.maxNotionalUsd / cfg.leverage,
    )
    const notionalUsd = collateralUsd * cfg.leverage
    if (notionalUsd < cfg.minNotionalUsd) continue

    const dir = isLong ? 1 : -1
    intents.push({
      kind: 'open',
      sleeve: 'A',
      market,
      isLong,
      collateralUsd: round2(collateralUsd),
      notionalUsd: round2(notionalUsd),
      refPrice: last.c,
      tpPrice: last.c * (1 + dir * cfg.tpPct),
      slPrice: last.c * (1 - dir * cfg.slPct),
      signalBarTs: last.t,
      reason: `EMA${cfg.emaFast}${isLong ? '>' : '<'}EMA${cfg.emaSlow} + donchian ${isLong ? 'high' : 'low'} break @ ${last.c}`,
    })
    // One new entry per run keeps tx count and CELO-in-flight bounded.
    break
  }

  return intents
}

function round2(x) {
  return Math.round(x * 100) / 100
}

module.exports = { tick }
