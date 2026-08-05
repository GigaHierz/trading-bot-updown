const test = require('node:test')
const assert = require('node:assert')
const sleeveA = require('../src/strategy/sleeveA')
const sleeveB = require('../src/strategy/sleeveB')
const { initialSleeve } = require('../src/state/store')

const HOUR = 3600 * 1000

// Bars ending in a strong up-move: EMA fast > slow and last close breaks the
// prior high. One extra unfinished bar is appended (must be ignored).
function breakoutCandles({ base = 100, bars = 80 } = {}) {
  const out = []
  let price = base
  for (let i = 0; i < bars; i += 1) {
    const rising = i > bars - 15
    price = rising ? price * 1.01 : price * (i % 2 === 0 ? 1.001 : 0.999)
    out.push({ t: i * HOUR, o: price, h: price * 1.002, l: price * 0.998, c: price })
  }
  out.push({ t: bars * HOUR, o: price, h: price, l: price, c: price }) // unfinished
  return out
}

function flatCandles({ base = 100, bars = 80 } = {}) {
  return Array.from({ length: bars + 1 }, (_, i) => ({
    t: i * HOUR,
    o: base,
    h: base * 1.001,
    l: base * 0.999,
    c: base * (i % 2 === 0 ? 1.0005 : 0.9995),
  }))
}

test('sleeve A enters long on breakout and sets TP/SL', () => {
  const sleeve = initialSleeve(10)
  const intents = sleeveA.tick({
    candlesByMarket: { ETH: breakoutCandles(), CELO: flatCandles() },
    sleeve,
    now: new Date(),
  })
  assert.equal(intents.length, 1)
  const i = intents[0]
  assert.equal(i.kind, 'open')
  assert.equal(i.market, 'ETH')
  assert.equal(i.isLong, true)
  assert.ok(i.tpPrice > i.refPrice)
  assert.ok(i.slPrice < i.refPrice)
  assert.ok(i.notionalUsd <= 25)
  assert.ok(Math.abs(i.notionalUsd - i.collateralUsd * 3) < 0.05)
})

test('sleeve A does not re-enter on the same signal bar', () => {
  const sleeve = initialSleeve(10)
  const candles = { ETH: breakoutCandles(), CELO: flatCandles() }
  const first = sleeveA.tick({ candlesByMarket: candles, sleeve, now: new Date() })
  sleeve.lastSignalBar.ETH = first[0].signalBarTs
  const second = sleeveA.tick({ candlesByMarket: candles, sleeve, now: new Date() })
  assert.equal(second.length, 0)
})

test('sleeve A respects daily entry cap', () => {
  const sleeve = initialSleeve(10)
  sleeve.tradesToday = { date: new Date().toISOString().slice(0, 10), count: 3 }
  const intents = sleeveA.tick({
    candlesByMarket: { ETH: breakoutCandles(), CELO: flatCandles() },
    sleeve,
    now: new Date(),
  })
  assert.equal(intents.length, 0)
})

test('sleeve A emits time-stop close for stale positions', () => {
  const sleeve = initialSleeve(10)
  sleeve.positions.ETH = {
    status: 'open',
    isLong: true,
    openedAt: new Date(Date.now() - 60 * HOUR).toISOString(),
  }
  const intents = sleeveA.tick({
    candlesByMarket: { ETH: flatCandles(), CELO: flatCandles() },
    sleeve,
    now: new Date(),
  })
  assert.equal(intents.length, 1)
  assert.equal(intents[0].kind, 'close')
})

test('sleeve B stays flat inside the dead zone', () => {
  const sleeve = initialSleeve(10)
  const intents = sleeveB.tick({
    candlesByMarket: { BTC: flatCandles() },
    sleeve,
    now: new Date(),
  })
  assert.equal(intents.length, 0)
})

test('sleeve B goes long in a clear uptrend at 1.5x', () => {
  const sleeve = initialSleeve(10)
  const rising = Array.from({ length: 81 }, (_, i) => {
    const price = 100 * Math.pow(1.004, i)
    return { t: i * HOUR, o: price, h: price * 1.001, l: price * 0.999, c: price }
  })
  const intents = sleeveB.tick({ candlesByMarket: { BTC: rising }, sleeve, now: new Date() })
  assert.equal(intents.length, 1)
  assert.equal(intents[0].isLong, true)
  assert.ok(intents[0].notionalUsd <= 12)
})

test('halted sleeve B only emits close intents', () => {
  const sleeve = initialSleeve(10)
  sleeve.halted = true
  sleeve.positions.BTC = { status: 'open', isLong: true, openedAt: new Date().toISOString() }
  const intents = sleeveB.tick({ candlesByMarket: { BTC: flatCandles() }, sleeve, now: new Date() })
  assert.equal(intents.length, 1)
  assert.equal(intents[0].kind, 'close')
})
