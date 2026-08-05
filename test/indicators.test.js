const test = require('node:test')
const assert = require('node:assert')
const { ema, donchianHigh, donchianLow } = require('../src/strategy/indicators')

test('ema returns null with insufficient data', () => {
  assert.equal(ema([1, 2], 5), null)
})

test('ema of constant series is the constant', () => {
  const values = Array(50).fill(7)
  assert.ok(Math.abs(ema(values, 10) - 7) < 1e-9)
})

test('ema tracks a rising series between min and max', () => {
  const values = Array.from({ length: 60 }, (_, i) => 100 + i)
  const result = ema(values, 20)
  assert.ok(result > 100 && result < 160)
  assert.ok(result > ema(values, 40)) // faster EMA sits closer to the latest value
})

test('donchian channels exclude the last bar', () => {
  const bars = [
    { h: 10, l: 5 },
    { h: 12, l: 6 },
    { h: 11, l: 4 },
    { h: 99, l: 1 }, // last bar must not count toward its own breakout level
  ]
  assert.equal(donchianHigh(bars, 3), 12)
  assert.equal(donchianLow(bars, 3), 4)
})

test('donchian returns null with insufficient data', () => {
  assert.equal(donchianHigh([{ h: 1, l: 1 }], 24), null)
})
