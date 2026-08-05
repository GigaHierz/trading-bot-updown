process.env.UPDOWN_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'simcycle-'),
)

const test = require('node:test')
const assert = require('node:assert')
const store = require('../src/state/store')
const sleeveA = require('../src/strategy/sleeveA')
const { createSimulator } = require('../src/exchange/simulator')
const { reconcile } = require('../src/exchange/reconcile')

const HOUR = 3600e3

test('full dry-run cycle: breakout entry then TP fill on a later candle', async () => {
  const state = store.initialState()

  let price = 100
  const eth = Array.from({ length: 81 }, (_, i) => {
    const rising = i > 66
    price = rising ? price * 1.01 : price * (i % 2 ? 0.999 : 1.001)
    return { t: i * HOUR, o: price, h: price * 1.002, l: price * 0.998, c: price }
  })
  const flat = Array.from({ length: 81 }, (_, i) => ({
    t: i * HOUR,
    o: 50,
    h: 50.1,
    l: 49.9,
    c: 50,
  }))

  const intents = sleeveA.tick({
    candlesByMarket: { ETH: eth, CELO: flat },
    sleeve: state.sleeves.A,
    now: new Date(),
  })
  assert.equal(intents.length, 1)
  const intent = intents[0]

  const sim = createSimulator({ state, prices: { ETH: intent.refPrice, CELO: 50, BTC: 1e5 } })
  const res = await sim.openPosition(intent)
  assert.ok(res.fillPrice > intent.refPrice) // long entry pays the modeled impact
  state.sleeves.A.positions.ETH = {
    status: 'open',
    isLong: intent.isLong,
    notionalUsd: intent.notionalUsd,
    collateralUsd: intent.collateralUsd,
    entryPrice: res.fillPrice,
    tpPrice: intent.tpPrice,
    slPrice: intent.slPrice,
    openedAt: new Date(Date.now() - 3 * HOUR).toISOString(),
  }

  const tpBar = {
    t: Date.now(),
    o: intent.refPrice,
    h: intent.tpPrice * 1.01,
    l: intent.refPrice * 0.999,
    c: intent.tpPrice,
  }
  await reconcile({
    state,
    snap: await sim.snapshot(),
    candlesByMarket: { ETH: [...eth, tpBar] },
    adapter: sim,
    now: Date.now(),
  })

  assert.equal(state.sleeves.A.positions.ETH, undefined)
  assert.ok(state.sleeves.A.equity > 10, `equity should grow after TP, got ${state.sleeves.A.equity}`)
})

test('sim cycle: SL bar closes the position at a loss', async () => {
  const state = store.initialState()
  state.sleeves.A.positions.ETH = {
    status: 'open',
    isLong: true,
    notionalUsd: 15,
    collateralUsd: 5,
    entryPrice: 100,
    tpPrice: 106,
    slPrice: 97.5,
    openedAt: new Date(Date.now() - HOUR).toISOString(),
  }
  const sim = createSimulator({ state, prices: { ETH: 99, CELO: 50, BTC: 1e5 } })
  const slBar = { t: Date.now(), o: 99, h: 99.5, l: 97, c: 97.2 }
  await reconcile({
    state,
    snap: await sim.snapshot(),
    candlesByMarket: { ETH: [slBar] },
    adapter: sim,
    now: Date.now(),
  })
  assert.equal(state.sleeves.A.positions.ETH, undefined)
  assert.ok(state.sleeves.A.equity < 10)
})
