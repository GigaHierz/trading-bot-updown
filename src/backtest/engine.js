// Offline replay of the real strategy against historical candles.
//
// The whole point is the cadence model: this replays sleeveA.tick/sleeveB.tick
// and reconcileSim -- the actual production functions, via the injectable cfg
// and econ parameters -- but only at simulated poll times. Anything the live
// bot would not have seen, this does not see either.
//
// DUPLICATION, KNOWN AND DELIBERATE: ~40 lines below mirror the bookkeeping in
// src/index.js executeOpen/executeClose. They cannot be called directly --
// index.js is a script whose main() runs on require, and store.appendTrade
// stamps wall-clock time rather than simulated time. The strategy and the
// fill/PnL maths ARE shared; only the record-building is copied, and
// test/backtest.test.js asserts the copied open-row shape still matches the
// rows the live bot writes.

const config = require('../config')
const store = require('../state/store')
const sleeveA = require('../strategy/sleeveA')
const sleeveB = require('../strategy/sleeveB')
const { filterIntents, applyDrawdownHalt } = require('../risk')
const { reconcile, realize } = require('../exchange/reconcile')
const { sliceHistory, intervalMs } = require('./history')
const { pollTimes, cadenceStats, makeRng } = require('./cadence')

const round6 = (x) => Number(Number(x).toPrecision(8))
const round2 = (x) => Math.round(x * 100) / 100

async function runBacktest({
  historyByMarket, // { ETH: {interval, bars}, ... }
  from,
  to,
  paramsA = config.sleeves.A,
  paramsB = config.sleeves.B,
  marketsA = config.sleeveMarkets.A,
  marketsB = config.sleeveMarkets.B,
  cadence = { mode: 'empirical', regime: 'current' },
  costs = {},
  candleLimit = config.candles.limit,
  staleGate = true,
  reanchor = true,
  startEquity = 10.45,
  celoStartBalance = null, // null = unlimited gas
  seed = 1,
}) {
  const {
    roundTripFeeRate = config.risk.roundTripFeeRate,
    slippageBps = config.risk.simSlippageBps,
    celoPerRoundTrip = config.risk.celoPerRoundTrip,
    celoUsd = 0.08,
  } = costs

  // Exit slippage folds into the fee rate (simulator.js does the same); the
  // CELO execution fee is a flat per-round-trip cost the live ledger omits.
  const econFeeRate = roundTripFeeRate + slippageBps / 1e4
  const flatCostUsd = celoPerRoundTrip * celoUsd

  const state = store.initialState()
  state.sleeves.A = store.initialSleeve(startEquity)
  state.sleeves.B = store.initialSleeve(startEquity)

  const trades = []
  let simNow = new Date(from).getTime()
  const sink = {
    trade: (row) => trades.push({ ts: new Date(simNow).toISOString(), ...row }),
    note: () => {}, // silence log.js: its summary buffer would grow across a sweep
  }
  const econ = { feeRate: econFeeRate, flatCostUsd, sink }

  let celo = celoStartBalance
  let blockedByGas = 0
  let staleSkips = 0

  const barMs = intervalMs(paramsA.interval)
  const times = pollTimes({ ...cadence, from, to, barMs, rng: makeRng(seed) })

  for (const T of times) {
    simNow = T

    // What the bot can see right now, at each sleeve's own timeframe.
    const visible = {}
    const prices = {}
    const barOpens = {}
    for (const market of [...marketsA, ...marketsB]) {
      const h = historyByMarket[market]
      if (!h) continue
      const slice = sliceHistory(h.bars, T, candleLimit)
      if (!slice.length) continue
      visible[market] = slice
      prices[market] = slice[slice.length - 1].c
      // The in-progress bar's OPEN is known at bar start; its close is not.
      // Using the open keeps the staleness gate strictly non-lookahead.
      barOpens[market] = slice[slice.length - 1].o
    }

    const snap = {
      celoBalance: celo,
      wusdtBalance: null,
      minPositionSizeUsd: null,
      positions: [],
      orders: [],
      prices,
    }

    // Same order as src/index.js: reconcile, halt, then signal.
    await reconcile({ state, snap, candlesByMarket: visible, adapter: { dry: true }, now: T, econ })
    applyDrawdownHalt(state, paramsB)

    const now = new Date(T)
    const intents = [
      ...sleeveA.tick({ candlesByMarket: visible, sleeve: state.sleeves.A, now, cfg: paramsA, markets: marketsA }),
      ...sleeveB.tick({ candlesByMarket: visible, sleeve: state.sleeves.B, now, cfg: paramsB, markets: marketsB }),
    ]

    const { allowed, skipped } = filterIntents({ intents, snapshot: snap, state })
    blockedByGas += skipped.filter((s) => /CELO/.test(s.reason)).length

    let tx = 0
    for (const intent of allowed) {
      if (tx >= config.risk.maxTxPerRun) break
      if (intent.kind === 'open') {
        const sleeve = state.sleeves[intent.sleeve]

        // index.js:137 staleness gate. It is live-only in production, and it
        // BURNS the bar on rejection -- the signal is never retried.
        if (staleGate) {
          const spot = barOpens[intent.market]
          const dir = intent.isLong ? 1 : -1
          if (spot && (dir * (spot - intent.refPrice)) / intent.refPrice < -0.01) {
            sleeve.lastSignalBar[intent.market] = intent.signalBarTs
            staleSkips += 1
            continue
          }
        }

        const dir = intent.isLong ? 1 : -1
        const fill = intent.refPrice * (1 + (dir * slippageBps) / 1e4)
        const cfg = intent.sleeve === 'A' ? paramsA : paramsB
        // index.js:196 re-anchors TP/SL to the oracle price at keeper fill.
        const anchor = reanchor ? fill : intent.refPrice
        const record = {
          status: 'open',
          isLong: intent.isLong,
          notionalUsd: intent.notionalUsd,
          collateralUsd: intent.collateralUsd,
          entryPrice: fill,
          tpPrice: round6(anchor * (1 + dir * cfg.tpPct)),
          slPrice: round6(anchor * (1 - dir * cfg.slPct)),
          openedAt: new Date(T).toISOString(),
          openOrderKey: `bt-${state.sim.nextId++}`,
        }
        sleeve.positions[intent.market] = record
        store.recordEntry(sleeve, now)
        sleeve.lastSignalBar[intent.market] = intent.signalBarTs
        sink.trade({
          sleeve: intent.sleeve,
          market: intent.market,
          side: intent.isLong ? 'long' : 'short',
          action: 'open',
          notionalUsd: intent.notionalUsd,
          entryPrice: fill,
          tpPrice: record.tpPrice,
          slPrice: record.slPrice,
          reason: intent.reason,
          txHash: null,
          dry: true,
        })
        if (celo !== null) celo -= celoPerRoundTrip
        tx += 1
      } else if (intent.kind === 'close') {
        const sleeve = state.sleeves[intent.sleeve]
        const record = sleeve.positions[intent.market]
        if (!record) continue
        const dir = record.isLong ? 1 : -1
        const exit = prices[intent.market] * (1 - (dir * slippageBps) / 1e4)
        realize({
          state,
          sleeveName: intent.sleeve,
          market: intent.market,
          record,
          exitPrice: exit,
          action: intent.reason,
          dry: true,
          econ,
        })
        tx += 1
      }
    }
  }

  const openAtEnd = []
  for (const [name, sleeve] of Object.entries(state.sleeves)) {
    for (const market of Object.keys(sleeve.positions)) openAtEnd.push(`${name}/${market}`)
  }

  return {
    trades,
    finalState: state,
    equity: {
      A: round2(state.sleeves.A.equity),
      B: round2(state.sleeves.B.equity),
      start: round2(startEquity * 2),
      end: round2(state.sleeves.A.equity + state.sleeves.B.equity),
    },
    cadenceStats: cadenceStats(times),
    blockedByGas,
    staleSkips,
    celoLeft: celo,
    openAtEnd,
  }
}

module.exports = { runBacktest }
