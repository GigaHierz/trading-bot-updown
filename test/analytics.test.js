const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const {
  analyze,
  parseRows,
  pairRoundTrips,
  normalizeExitReason,
  summarize,
  maxDrawdown,
  equityCurve,
  timeInMarket,
  costDrag,
} = require('../src/analytics')

const openRow = (o) => ({
  ts: '2026-01-01T00:00:00.000Z',
  sleeve: 'A',
  market: 'ETH',
  side: 'long',
  action: 'open',
  notionalUsd: 15,
  entryPrice: 100,
  dry: false,
  ...o,
})
const closeRow = (o) => ({
  ts: '2026-01-02T00:00:00.000Z',
  sleeve: 'A',
  market: 'ETH',
  side: 'long',
  action: 'tp',
  notionalUsd: 15,
  entryPrice: 100,
  exitPrice: 106,
  pnlUsd: 0.9,
  dry: false,
  ...o,
})

// --- pairing ------------------------------------------------------------

test('an open and its close pair into one round trip', () => {
  const { trips, openTrips, orphanCloses } = pairRoundTrips([openRow(), closeRow()])
  assert.equal(trips.length, 1)
  assert.equal(openTrips.length, 0)
  assert.equal(orphanCloses.length, 0)
  assert.equal(trips[0].holdHours, 24)
  assert.equal(trips[0].mode, 'live')
})

test('interleaved markets and sleeves pair on their own keys', () => {
  const rows = [
    openRow({ ts: '2026-01-01T00:00:00.000Z', market: 'ETH' }),
    openRow({ ts: '2026-01-01T01:00:00.000Z', sleeve: 'B', market: 'BTC' }),
    closeRow({ ts: '2026-01-01T02:00:00.000Z', sleeve: 'B', market: 'BTC', pnlUsd: 1 }),
    closeRow({ ts: '2026-01-01T03:00:00.000Z', market: 'ETH', pnlUsd: -1 }),
  ]
  const { trips } = pairRoundTrips(rows)
  assert.equal(trips.length, 2)
  assert.deepEqual(
    trips.map((t) => `${t.sleeve}/${t.market}`).sort(),
    ['A/ETH', 'B/BTC'],
  )
})

test('an unpaired open is reported as still open, not as a trade', () => {
  const { trips, openTrips } = pairRoundTrips([openRow()])
  assert.equal(trips.length, 0)
  assert.equal(openTrips.length, 1)
  assert.equal(summarize(trips).trades, 0)
})

test('a close with no matching open is an orphan, not a trade', () => {
  const { trips, orphanCloses } = pairRoundTrips([closeRow()])
  assert.equal(trips.length, 0)
  assert.equal(orphanCloses.length, 1)
})

test('a trip that opens dry and closes live is neither live nor dry', () => {
  const { trips } = pairRoundTrips([openRow({ dry: true }), closeRow({ dry: false })])
  assert.equal(trips[0].mode, 'mixed')
})

// The open row is written before the keeper fills; index.js re-anchors to the
// oracle fill price afterwards, so the close row carries the real cost basis.
test('the close row overrides the open row entry price and notional', () => {
  const { trips } = pairRoundTrips([
    openRow({ entryPrice: 2430.09, notionalUsd: 14.31 }),
    closeRow({ entryPrice: 2458.071715, notionalUsd: 14.4, pnlUsd: 0.1 }),
  ])
  assert.equal(trips[0].entryPrice, 2458.071715)
  assert.equal(trips[0].notionalUsd, 14.4)
  assert.equal(trips[0].signalPrice, 2430.09)
  assert.ok(Math.abs(trips[0].entrySlipPct - 0.011513) < 1e-5)
})

test('entry slip is signed against the trade direction', () => {
  const { trips } = pairRoundTrips([
    openRow({ side: 'short', entryPrice: 100 }),
    closeRow({ side: 'short', entryPrice: 99, pnlUsd: 0 }),
  ])
  // A short filled lower than its signal is a favourable slip.
  assert.ok(trips[0].entrySlipPct > 0)
})

test('exit reasons collapse to a stable set', () => {
  assert.equal(normalizeExitReason('time-stop after 49h'), 'time-stop')
  assert.equal(normalizeExitReason('trend filter flat (spread 0.39%)'), 'trend-filter')
  assert.equal(normalizeExitReason('gas-guard flatten (CELO exhausted)'), 'gas-guard')
  assert.equal(normalizeExitReason('closed-unattributed'), 'unattributed')
  assert.equal(normalizeExitReason('tp'), 'tp')
  assert.equal(normalizeExitReason('sl'), 'sl')
})

test('unparseable lines are collected, not thrown', () => {
  const { rows, badLines } = parseRows('{"ts":"2026-01-01T00:00:00.000Z"}\nnot json\n\n')
  assert.equal(rows.length, 1)
  assert.equal(badLines.length, 1)
  assert.equal(badLines[0].lineNo, 2)
})

// --- metrics ------------------------------------------------------------

test('summarize computes the expected arithmetic', () => {
  const trips = [{ pnlUsd: 2 }, { pnlUsd: -1 }, { pnlUsd: 3 }, { pnlUsd: -4 }]
  const s = summarize(trips)
  assert.equal(s.trades, 4)
  assert.equal(s.wins, 2)
  assert.equal(s.winRate, 0.5)
  assert.equal(s.grossProfit, 5)
  assert.equal(s.grossLoss, 5)
  assert.equal(s.profitFactor, 1)
  assert.equal(s.netPnlUsd, 0)
  assert.equal(s.expectancy, 0)
})

test('profit factor and mean loss are null rather than Infinity', () => {
  const s = summarize([{ pnlUsd: 1 }, { pnlUsd: 2 }])
  assert.equal(s.profitFactor, null)
  assert.equal(s.meanLoss, null)
  assert.equal(s.payoffRatio, null)
})

test('a zero-PnL trade counts as a loss, not a win', () => {
  const s = summarize([{ pnlUsd: 0 }])
  assert.equal(s.wins, 0)
  assert.equal(s.losses, 1)
})

test('max drawdown finds the deepest peak-to-trough', () => {
  const dd = maxDrawdown(equityCurve([{ pnlUsd: 2 }, { pnlUsd: -5 }, { pnlUsd: 1 }], 10))
  assert.equal(dd.maxDdUsd, 5)
  assert.ok(Math.abs(dd.maxDdPct - 5 / 12) < 1e-4)
})

test('time in market separates summed exposure from wall-clock coverage', () => {
  const trips = [
    { openTs: '2026-01-01T00:00:00Z', closeTs: '2026-01-01T10:00:00Z' },
    { openTs: '2026-01-01T05:00:00Z', closeTs: '2026-01-01T15:00:00Z' },
  ]
  const t = timeInMarket(trips, { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
  assert.equal(t.positionHours, 20) // two concurrent positions
  assert.equal(t.coverageHours, 15) // union of the two spans
  assert.ok(t.positionHours > t.coverageHours)
})

// The reason the booked ledger flatters the real result.
test('cost drag adds the CELO burn the ledger never charges', () => {
  const trips = Array.from({ length: 12 }, () => ({ pnlUsd: -0.1525, notionalUsd: 14.05 }))
  const c = costDrag(trips, { celoPerRoundTrip: 1.3, celoUsd: 0.08, roundTripFeeRate: 0.002 })
  assert.equal(c.trades, 12)
  assert.equal(c.gasCelo, 15.6)
  assert.equal(c.gasUsd, 1.25)
  assert.ok(c.netAfterGasUsd < c.netBookedUsd)
  assert.ok(Math.abs(c.netAfterGasUsd - (c.netBookedUsd - 1.25)) < 0.01)
})

test('cost drag is empty rather than NaN with no trades', () => {
  const c = costDrag([], { celoPerRoundTrip: 1.3, celoUsd: 0.08, roundTripFeeRate: 0.002 })
  assert.equal(c.trades, 0)
  assert.equal(c.costBpsOfNotional, null)
})

// --- golden test against the committed live log -------------------------
// Pins the numbers the strategy review was written from, so a future change to
// the pairing rules cannot silently restate history.

test('analyze reproduces the committed trade log', () => {
  const dir = path.join(__dirname, '../state')
  const { rows, badLines } = parseRows(fs.readFileSync(path.join(dir, 'trades.ndjson'), 'utf8'))
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))
  assert.equal(badLines.length, 0)
  assert.ok(rows.length >= 26)

  const r = analyze({
    rows,
    state,
    costs: { celoPerRoundTrip: 1.3, celoUsd: 0.08, roundTripFeeRate: 0.002 },
  })

  assert.equal(r.overall.all.trades, 13)
  assert.equal(r.overall.live.trades, 12)
  assert.equal(r.overall.live.wins, 4)
  assert.equal(r.anomalies.mixedModeTrips.length, 1)
  assert.equal(r.anomalies.orphanCloses.length, 0)
  assert.ok(Math.abs(r.overall.all.netPnlUsd - -1.85) < 0.005)

  // Booked equity must equal the sum of realized PnL, per sleeve.
  for (const drift of Object.values(r.anomalies.ledgerDrift)) {
    assert.ok(Math.abs(drift) < 0.01, `ledger drift ${drift}`)
  }

  // The finding that reframed the review: gas is ~40% of the true loss.
  assert.ok(r.costs.netAfterGasUsd < r.costs.netBookedUsd - 1.2)
  // And the sample is too small to tune on.
  assert.ok(Math.abs(r.tStat) < 2)
})
