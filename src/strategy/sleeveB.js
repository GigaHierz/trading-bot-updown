const config = require('../config')
const { ema } = require('./indicators')
const { closedBars } = require('../data/candles')
const { entriesToday } = require('../state/store')

// Filtered trend-following on 4h BTC bars. Desired exposure is the direction
// of EMA(fast) vs EMA(slow), but only when the spread exceeds a dead zone —
// otherwise flat. Exits to flat when the filter drops out or flips.
function tick({ candlesByMarket, sleeve, now }) {
  const cfg = config.sleeves.B
  const market = config.sleeveMarkets.B[0]
  const intents = []

  const position = sleeve.positions[market]

  if (sleeve.halted) {
    if (position && position.status === 'open') {
      intents.push({ kind: 'close', sleeve: 'B', market, reason: 'drawdown halt' })
    }
    return intents
  }

  const bars = closedBars(candlesByMarket[market] || [])
  if (bars.length < cfg.emaSlow + 5) return intents

  const closes = bars.map((b) => b.c)
  const last = bars[bars.length - 1]
  const fast = ema(closes, cfg.emaFast)
  const slow = ema(closes, cfg.emaSlow)
  if (fast === null || slow === null) return intents

  const spread = (fast - slow) / last.c
  let desired = 0
  if (spread > cfg.deadZonePct) desired = 1
  else if (spread < -cfg.deadZonePct) desired = -1

  if (position) {
    const held = position.isLong ? 1 : -1
    const ageHours = (now - new Date(position.openedAt)) / 3.6e6
    if (position.status === 'open' && (desired !== held || ageHours > cfg.timeStopHours)) {
      intents.push({
        kind: 'close',
        sleeve: 'B',
        market,
        reason:
          desired !== held
            ? `trend filter ${desired === 0 ? 'flat' : 'flipped'} (spread ${(spread * 100).toFixed(2)}%)`
            : `time-stop after ${Math.round(ageHours)}h`,
      })
    }
    return intents
  }

  if (desired === 0) return intents
  if (entriesToday(sleeve, now) >= cfg.maxEntriesPerDay) return intents
  if (sleeve.lastSignalBar[market] === last.t) return intents

  const collateralUsd = Math.min(cfg.collateralUsd, sleeve.equity * 0.9)
  const notionalUsd = Math.min(collateralUsd * cfg.leverage, cfg.maxNotionalUsd)
  if (notionalUsd < cfg.minNotionalUsd) return intents

  const isLong = desired === 1
  const dir = isLong ? 1 : -1
  intents.push({
    kind: 'open',
    sleeve: 'B',
    market,
    isLong,
    collateralUsd: Math.round(collateralUsd * 100) / 100,
    notionalUsd: Math.round(notionalUsd * 100) / 100,
    refPrice: last.c,
    tpPrice: last.c * (1 + dir * cfg.tpPct),
    slPrice: last.c * (1 - dir * cfg.slPct),
    signalBarTs: last.t,
    reason: `EMA${cfg.emaFast}/${cfg.emaSlow} spread ${(spread * 100).toFixed(2)}% ${isLong ? 'long' : 'short'} @ ${last.c}`,
  })
  return intents
}

module.exports = { tick }
