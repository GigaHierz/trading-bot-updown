const test = require('node:test')
const assert = require('node:assert')
const { filterIntents, applyDrawdownHalt } = require('../src/risk')
const { initialState } = require('../src/state/store')

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
