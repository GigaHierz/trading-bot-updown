process.env.UPDOWN_STATE_DIR = require('os').tmpdir()

const test = require('node:test')
const assert = require('node:assert')
const { attributeExit, realize } = require('../src/exchange/reconcile')
const { initialState } = require('../src/state/store')

const longRecord = {
  status: 'open',
  isLong: true,
  notionalUsd: 15,
  collateralUsd: 5,
  entryPrice: 100,
  tpPrice: 106,
  slPrice: 97.5,
}

test('exit attribution: price at TP means take-profit', () => {
  const { action, price } = attributeExit({ record: longRecord, price: 106.2 })
  assert.equal(action, 'tp')
  assert.equal(price, 106)
})

test('exit attribution: price at SL means stop-loss', () => {
  const { action, price } = attributeExit({ record: longRecord, price: 97.3 })
  assert.equal(action, 'sl')
  assert.equal(price, 97.5)
})

test('exit attribution: closing record uses its close reason', () => {
  const record = { ...longRecord, status: 'closing', closeReason: 'time-stop' }
  const { action } = attributeExit({ record, price: 101 })
  assert.equal(action, 'time-stop')
})

test('realize updates equity, high-water mark, and removes the position', () => {
  const state = initialState()
  state.sleeves.A.positions.ETH = { ...longRecord }
  realize({
    state,
    sleeveName: 'A',
    market: 'ETH',
    record: state.sleeves.A.positions.ETH,
    exitPrice: 106,
    action: 'tp',
    dry: true,
  })
  // +6% on 15 notional = +0.90 gross, minus 0.2% round-trip fees (0.03).
  assert.ok(Math.abs(state.sleeves.A.equity - 10.87) < 0.011)
  assert.equal(state.sleeves.A.positions.ETH, undefined)
  assert.ok(state.sleeves.A.highWaterMark >= state.sleeves.A.equity)
})

test('realize on a losing short reduces equity', () => {
  const state = initialState()
  const record = { ...longRecord, isLong: false, tpPrice: 94, slPrice: 102.5 }
  state.sleeves.A.positions.ETH = record
  realize({
    state,
    sleeveName: 'A',
    market: 'ETH',
    record,
    exitPrice: 102.5,
    action: 'sl',
    dry: true,
  })
  assert.ok(state.sleeves.A.equity < 10)
})
