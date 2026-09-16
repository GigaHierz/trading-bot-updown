process.env.UPDOWN_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'updown-bt-'),
)

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const { makeRng, pollTimes, cadenceStats, sampleGapMinutes, GAP_QUANTILES } = require('../src/backtest/cadence')
const { sliceHistory, intervalMs } = require('../src/backtest/history')
const { expandGrid, rankCells } = require('../src/backtest/sweep')
const { runBacktest } = require('../src/backtest/engine')
const config = require('../src/config')

const HOUR = 3600000

// Synthetic bars: no test may touch the network.
function bars({ n, start = Date.UTC(2026, 0, 1), step = HOUR, price = (i) => 100 + i }) {
  return Array.from({ length: n }, (_, i) => {
    const c = price(i)
    return { t: start + i * step, o: c, h: c * 1.001, l: c * 0.999, c }
  })
}

// --- cadence ------------------------------------------------------------

test('bar cadence polls once per bar, just after each close', () => {
  const from = Date.UTC(2026, 0, 1)
  const to = from + 10 * HOUR
  const times = pollTimes({ mode: 'bar', from, to, barMs: HOUR })
  assert.equal(times.length, 11)
  for (let i = 1; i < times.length; i += 1) {
    assert.equal(times[i] - times[i - 1], HOUR)
    assert.equal(times[i] % HOUR, 1) // 1ms after the boundary
  }
})

test('fixed cadence uses a constant gap', () => {
  const from = Date.UTC(2026, 0, 1)
  const times = pollTimes({ mode: 'fixed', from, to: from + 10 * HOUR, intervalMs: 30 * 60000 })
  for (let i = 1; i < times.length; i += 1) {
    assert.equal(times[i] - times[i - 1], 30 * 60000)
  }
})

test('the same seed produces the same poll sequence', () => {
  const opts = { mode: 'empirical', from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) }
  const a = pollTimes({ ...opts, rng: makeRng(7) })
  const b = pollTimes({ ...opts, rng: makeRng(7) })
  const c = pollTimes({ ...opts, rng: makeRng(8) })
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
})

// The whole backtest rests on this distribution matching production.
test('the empirical sampler reproduces the measured run cadence', () => {
  const times = pollTimes({
    mode: 'empirical',
    regime: 'current',
    from: Date.UTC(2026, 0, 1),
    to: Date.UTC(2026, 6, 1),
    rng: makeRng(1),
  })
  const s = cadenceStats(times)
  // Measured 2026-08-27 onward: mean 222.4, p50 206.8, p90 325.5, 6.5 runs/day.
  assert.ok(Math.abs(s.meanGapMin - 222.4) < 15, `mean ${s.meanGapMin}`)
  assert.ok(Math.abs(s.p50GapMin - 206.8) < 20, `p50 ${s.p50GapMin}`)
  assert.ok(Math.abs(s.p90GapMin - 325.5) < 25, `p90 ${s.p90GapMin}`)
  assert.ok(Math.abs(s.perDay - 6.5) < 0.6, `perDay ${s.perDay}`)
})

test('the inverse CDF is monotonic across the knot table', () => {
  let prev = -Infinity
  for (let u = 0; u <= 1; u += 0.01) {
    const v = sampleGapMinutes(GAP_QUANTILES.current, u)
    assert.ok(v >= prev, `not monotonic at u=${u}`)
    prev = v
  }
})

// --- history slicing ----------------------------------------------------

test('sliceHistory shows the in-progress bar last, like live getCandles', () => {
  const h = bars({ n: 50 })
  const T = h[20].t + HOUR / 2 // halfway through bar 20
  const s = sliceHistory(h, T, 120)
  assert.equal(s[s.length - 1].t, h[20].t)
  const { closedBars } = require('../src/data/candles')
  const closed = closedBars(s)
  // The last CLOSED bar must have finished before T.
  assert.ok(closed[closed.length - 1].t + HOUR <= T)
})

test('sliceHistory respects the live 120-bar window', () => {
  const h = bars({ n: 500 })
  const s = sliceHistory(h, h[400].t, 120)
  assert.equal(s.length, 120)
  assert.equal(s[s.length - 1].t, h[400].t)
})

// A backtest that can see the future is worthless. This is the guard.
test('no lookahead: future bars cannot change the decision at T', async () => {
  const short = bars({ n: 200 })
  const withSpike = [...short, { t: short[199].t + HOUR, o: 1e5, h: 2e5, l: 9e4, c: 1.9e5 }]
  const T = short[199].t + HOUR / 2
  assert.deepEqual(sliceHistory(short, T, 120), sliceHistory(withSpike, T, 120))
})

// --- engine -------------------------------------------------------------

function history(n = 400) {
  // A steady uptrend, enough bars for both sleeves' warmup.
  const h1 = bars({ n, price: (i) => 100 * (1 + i * 0.002) })
  const h4 = bars({ n, step: 4 * HOUR, price: (i) => 1000 * (1 + i * 0.002) })
  return { ETH: { interval: '1h', bars: h1 }, CELO: { interval: '1h', bars: h1 }, BTC: { interval: '4h', bars: h4 } }
}

test('the engine trades and books PnL through the real realize()', async () => {
  const h = history()
  const res = await runBacktest({
    historyByMarket: h,
    from: new Date(h.ETH.bars[0].t).toISOString(),
    to: new Date(h.ETH.bars.at(-1).t).toISOString(),
    cadence: { mode: 'bar' },
    seed: 1,
  })
  assert.ok(res.trades.length > 0, 'expected the engine to trade')
  assert.ok(res.trades.some((t) => t.action === 'open'))
  assert.equal(typeof res.equity.end, 'number')
})

// The known, documented duplication of index.js bookkeeping is only safe if
// the rows it writes still look like the rows the live bot writes.
test('engine open rows match the shape of real committed open rows', async () => {
  const h = history()
  const res = await runBacktest({
    historyByMarket: h,
    from: new Date(h.ETH.bars[0].t).toISOString(),
    to: new Date(h.ETH.bars.at(-1).t).toISOString(),
    cadence: { mode: 'bar' },
    seed: 1,
  })
  const engineOpen = res.trades.find((t) => t.action === 'open')
  assert.ok(engineOpen, 'engine produced no open row')

  const live = fs
    .readFileSync(path.join(__dirname, '../state/trades.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .find((r) => r.action === 'open')

  assert.deepEqual(Object.keys(engineOpen).sort(), Object.keys(live).sort())
})

test('a finite CELO balance stops the engine entering, like the live gate', async () => {
  const h = history()
  const opts = {
    historyByMarket: h,
    from: new Date(h.ETH.bars[0].t).toISOString(),
    to: new Date(h.ETH.bars.at(-1).t).toISOString(),
    cadence: { mode: 'bar' },
    seed: 1,
  }
  const unlimited = await runBacktest({ ...opts, celoStartBalance: null })
  const starved = await runBacktest({ ...opts, celoStartBalance: config.risk.minCeloForEntry + 1 })
  const opens = (r) => r.trades.filter((t) => t.action === 'open').length
  assert.ok(opens(starved) < opens(unlimited))
  assert.ok(starved.blockedByGas > 0)
})

test('costs are charged per round trip', async () => {
  const h = history()
  const opts = {
    historyByMarket: h,
    from: new Date(h.ETH.bars[0].t).toISOString(),
    to: new Date(h.ETH.bars.at(-1).t).toISOString(),
    cadence: { mode: 'bar' },
    seed: 1,
  }
  const free = await runBacktest({
    ...opts,
    costs: { roundTripFeeRate: 0, slippageBps: 0, celoPerRoundTrip: 0, celoUsd: 0 },
  })
  const costly = await runBacktest({
    ...opts,
    costs: { roundTripFeeRate: 0.002, slippageBps: 30, celoPerRoundTrip: 1.3, celoUsd: 0.08 },
  })
  assert.ok(costly.equity.end < free.equity.end, 'costs must reduce final equity')
})

test('injected params actually reach the strategy', async () => {
  const h = history()
  const res = await runBacktest({
    historyByMarket: h,
    from: new Date(h.ETH.bars[0].t).toISOString(),
    to: new Date(h.ETH.bars.at(-1).t).toISOString(),
    cadence: { mode: 'bar' },
    paramsA: { ...config.sleeves.A, tpPct: 0.5 },
    seed: 1,
  })
  const open = res.trades.find((t) => t.action === 'open' && t.sleeve === 'A')
  if (open) {
    const ratio = open.side === 'long' ? open.tpPrice / open.entryPrice : open.entryPrice / open.tpPrice
    assert.ok(Math.abs(ratio - 1.5) < 0.01, `tp ratio ${ratio}`)
  }
})

// --- sweep --------------------------------------------------------------

test('expandGrid produces the cartesian product', () => {
  const cells = expandGrid('A.tpPct=0.03,0.06;A.slPct=0.02,0.03,0.04')
  assert.equal(cells.length, 6)
  assert.ok(cells.every((c) => 'tpPct' in c.A && 'slPct' in c.A))
})

test('expandGrid refuses an oversized grid and malformed axes', () => {
  assert.throws(() => expandGrid('A.tpPct=0.01,0.02,0.03,0.04', { maxCells: 3 }), /cap is 3/)
  assert.throws(() => expandGrid('tpPct=0.01'), /A\. or B\./)
  assert.throws(() => expandGrid('A.tpPct'), /Malformed/)
})

test('rankCells flags small samples and insignificant edges', () => {
  const ranked = rankCells(
    [
      { label: 'a', expectancyBps: 10, expectancy: 1, stdErr: 0.1, trades: 100, net: 5, worstNet: 4 },
      { label: 'b', expectancyBps: 20, expectancy: 1, stdErr: 5, trades: 4, net: 9, worstNet: -1 },
    ],
    null,
    { minTrades: 30 },
  )
  assert.equal(ranked[0].label, 'b') // ranked on edge
  assert.match(ranked[0].flags, /n=4/)
  assert.match(ranked[0].flags, /\|t\|<2/)
  assert.match(ranked[0].flags, /seed-fragile/)
  assert.equal(ranked[1].flags, '')
})

test('intervalMs rejects an unsupported interval', () => {
  assert.equal(intervalMs('1h'), HOUR)
  assert.throws(() => intervalMs('7m'), /Unsupported/)
})
