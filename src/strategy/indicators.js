function ema(values, period) {
  if (values.length < period) return null
  const k = 2 / (period + 1)
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k)
  }
  return value
}

// Highest high of the `period` bars preceding the last bar (breakout reference).
function donchianHigh(candles, period) {
  if (candles.length < period + 1) return null
  const window = candles.slice(-period - 1, -1)
  return Math.max(...window.map((c) => c.h))
}

function donchianLow(candles, period) {
  if (candles.length < period + 1) return null
  const window = candles.slice(-period - 1, -1)
  return Math.min(...window.map((c) => c.l))
}

module.exports = { ema, donchianHigh, donchianLow }
