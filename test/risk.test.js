const test = require('node:test')
const assert = require('node:assert')
const { filterIntents, applyDrawdownHalt, gasGuard } = require('../src/risk')
const { initialState, recordGasSample, gasBurn } = require('../src/state/store')
const config = require('../src/config')

function snapshot(overrides = {}) {
  return {
    celoBalance: 10,
    wusdtBalance: 20,
    positions: [],
    orders: [],
    prices: {},
    minPositionSizeUsd: 1,
    ...overrides,
  }
}

const openIntent = {
  kind: 'open',
  sleeve: 'A',
  market: 'ETH',
  isLong: true,
  collateralUsd: 5,
  notionalUsd: 15,
}

test('open intent passes with healthy balances', () => {
  const { allowed, skipped } = filterIntents({
    intents: [openIntent],
    snapshot: snapshot(),
    state: initialState(),
  })
  assert.equal(allowed.length, 1)
  assert.equal(skipped.length, 0)
})

test('open intent blocked on low CELO (execution fees)', () => {
  const { allowed, skipped } = filterIntents({
    intents: [openIntent],
    snapshot: snapshot({ celoBalance: 2 }),
    state: initialState(),
  })
  assert.equal(allowed.length, 0)
  assert.match(skipped[0].reason, /CELO/)
})

test('open intent blocked below protocol minimum size', () => {
  const { allowed } = filterIntents({
    intents: [openIntent],
    snapshot: snapshot({ minPositionSizeUsd: 50 }),
    state: initialState(),
  })
  assert.equal(allowed.length, 0)
})

test('open intent blocked for halted sleeve', () => {
  const state = initialState()
  state.sleeves.A.halted = true
  const { allowed } = filterIntents({
    intents: [openIntent],
    snapshot: snapshot(),
    state,
  })
  assert.equal(allowed.length, 0)
})

test('close intents pass even when entry gates fail', () => {
  const { allowed } = filterIntents({
    intents: [{ kind: 'close', sleeve: 'B', market: 'BTC' }],
    snapshot: snapshot({ celoBalance: 2, wusdtBalance: 0 }),
    state: initialState(),
  })
  assert.equal(allowed.length, 1)
})

test('dry-run snapshot (null balances) does not block entries', () => {
  const { allowed } = filterIntents({
    intents: [openIntent],
    snapshot: snapshot({ celoBalance: null, wusdtBalance: null, minPositionSizeUsd: null }),
    state: initialState(),
  })
  assert.equal(allowed.length, 1)
})

test('drawdown halt triggers at the 5 USD floor and sticks', () => {
  const state = initialState()
  state.sleeves.B.equity = 4.8
  assert.equal(applyDrawdownHalt(state), true)
  assert.equal(state.sleeves.B.halted, true)
  assert.equal(applyDrawdownHalt(state), false) // already halted; fires once
})

// --- CELO execution-fee gates ------------------------------------------
// Regression cover for 2026-08-14: the bot opened a BTC short with 4.5 CELO,
// dropped under the exit gate the same evening, could not keep the stop armed,
// and the position ran ~6x past it.

test('the entry gate reserves enough CELO to protect and close what it opens', () => {
  const r = config.risk
  const inFlight = r.keeperFeeCelo * r.entryOrders
  assert.ok(
    r.minCeloForEntry >= inFlight + r.minCeloForExit,
    `entry gate ${r.minCeloForEntry} must exceed ${inFlight} in flight + ${r.minCeloForExit} to exit`,
  )
})

test('open intent blocked at a balance the old 5-CELO gate would have allowed', () => {
  const state = initialState()
  const { allowed, skipped } = filterIntents({
    intents: [{ kind: 'open', sleeve: 'A', market: 'ETH', collateralUsd: 5, notionalUsd: 15 }],
    snapshot: snapshot({ celoBalance: 6 }),
    state,
  })
  assert.equal(allowed.length, 0)
  assert.equal(skipped.length, 1)
  assert.match(skipped[0].reason, /reserved to protect\/close/)
})

function stateWithOpen(n = 1) {
  const state = initialState()
  const markets = ['ETH', 'CELO']
  for (let i = 0; i < n; i += 1) {
    state.sleeves.A.positions[markets[i]] = { status: 'open', isLong: true }
  }
  return state
}

test('gas guard flattens when an open position can no longer be protected', () => {
  const g = gasGuard({ snapshot: snapshot({ celoBalance: 0.9 }), state: stateWithOpen(1) })
  assert.equal(g.level, 'critical')
  assert.equal(g.flatten, true)
  assert.equal(g.openPositions, 1)
})

test('gas guard warns but holds when protection is still affordable', () => {
  const g = gasGuard({ snapshot: snapshot({ celoBalance: 5 }), state: stateWithOpen(1) })
  assert.equal(g.level, 'warn')
  assert.equal(g.flatten, false)
})

test('gas guard scales its floor with the number of open positions', () => {
  const held = snapshot({ celoBalance: 5 })
  assert.equal(gasGuard({ snapshot: held, state: stateWithOpen(1) }).flatten, false)
  assert.equal(gasGuard({ snapshot: held, state: stateWithOpen(2) }).flatten, true)
})

test('gas guard is silent on a funded, flat wallet', () => {
  const g = gasGuard({ snapshot: snapshot({ celoBalance: 20 }), state: initialState() })
  assert.equal(g.level, 'ok')
  assert.equal(g.reason, null)
})

test('gas guard never flattens on a dry run (null balance)', () => {
  const g = gasGuard({ snapshot: snapshot({ celoBalance: null }), state: stateWithOpen(2) })
  assert.equal(g.flatten, false)
  assert.equal(g.level, 'ok')
})

// --- CELO runway accounting --------------------------------------------

test('keeper refunds are not mistaken for top-ups', () => {
  const state = initialState()
  const at = (h) => new Date(Date.UTC(2026, 0, 1 + h))
  const sample = (celoBalance, hasExposure, h) =>
    recordGasSample(state, { celoBalance, hasExposure, maxRefundCelo: 8.4 }, at(h))

  sample(20, false, 0)
  sample(15.8, true, 1) // three keeper orders prepaid
  sample(19.1, true, 2) // refunded on fill — an increase, but not a top-up
  assert.equal(state.gas.topUpsCelo, 0)
  assert.equal(gasBurn(state, 1).netBurnCelo, 0.9)
})

test('a top-up into a flat wallet is counted as one', () => {
  const state = initialState()
  const at = (h) => new Date(Date.UTC(2026, 0, 1 + h))
  recordGasSample(state, { celoBalance: 4, hasExposure: false, maxRefundCelo: 8.4 }, at(0))
  recordGasSample(state, { celoBalance: 14, hasExposure: false, maxRefundCelo: 8.4 }, at(1))
  assert.equal(state.gas.topUpsCelo, 10)
  assert.equal(gasBurn(state, 0).netBurnCelo, 0)
})

test('gas burn reports nulls rather than guesses without history', () => {
  assert.deepEqual(gasBurn(initialState(), 3), {
    netBurnCelo: null,
    perTripCelo: null,
    perDayCelo: null,
    days: null,
  })
})
