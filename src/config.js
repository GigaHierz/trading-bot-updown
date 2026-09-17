// Every strategy/risk tunable in one place.

// Keeper execution-fee arithmetic. Kept as bare constants so the gates below
// are derived from one source rather than hand-tuned independently.
const KEEPER_FEE_CELO = 1.4
const FEE_MARGIN_CELO = 0.2
const ENTRY_ORDERS = 3 // open + TP + SL
const EXIT_RESERVE_ORDERS = 3 // worst case later: re-arm TP, re-arm SL, close
// Binary floats make these read as 8.599999999999998 in alerts; keep 1dp.
const celo = (n) => Math.round(n * 10) / 10

const tuning = require('./tuning')

const base = {
  // Market allowlist per sleeve. Disjoint on purpose: on-chain positions are
  // attributed to a sleeve purely by market, so the sets must never overlap.
  // The Mento FX markets (EURm/JPYm/...) are excluded entirely — order-book
  // depth there is a few tens of dollars.
  sleeveMarkets: {
    A: ['ETH', 'CELO'],
    B: ['BTC'],
  },

  candles: {
    binanceSymbols: { BTC: 'BTCUSDT', ETH: 'ETHUSDT', CELO: 'CELOUSDT' },
    okxInstIds: { BTC: 'BTC-USDT', ETH: 'ETH-USDT', CELO: 'CELO-USDT' },
    limit: 120,
  },

  sleeves: {
    A: {
      label: 'aggressive-momentum',
      initialEquity: 10,
      interval: '1h',
      emaFast: 8,
      emaSlow: 24,
      donchian: 24,
      leverage: 3,
      equityFractionPerTrade: 0.5,
      maxNotionalUsd: 25,
      minNotionalUsd: 6,
      tpPct: 0.06,
      slPct: 0.025,
      timeStopHours: 48,
      maxConcurrentPositions: 2,
      maxEntriesPerDay: 3,
    },
    B: {
      label: 'protective-trend',
      initialEquity: 10,
      interval: '4h',
      emaFast: 20,
      emaSlow: 60,
      deadZonePct: 0.004,
      leverage: 1.5,
      collateralUsd: 8,
      maxNotionalUsd: 12,
      minNotionalUsd: 6,
      tpPct: 0.03,
      slPct: 0.015,
      timeStopHours: 96,
      maxConcurrentPositions: 1,
      maxEntriesPerDay: 1,
      // Halt for good once equity falls to this fraction of starting equity.
      haltFraction: 0.5,
    },
  },

  risk: {
    // --- CELO execution-fee budget -------------------------------------
    // Each keeper order prepays >=1.4 CELO (refunded on execution/cancel).
    // Entry = open + TP + SL = 3 orders in flight.
    keeperFeeCelo: KEEPER_FEE_CELO,
    feeMarginCelo: FEE_MARGIN_CELO,
    entryOrders: ENTRY_ORDERS,
    exitReserveOrders: EXIT_RESERVE_ORDERS,
    // Both gates are DERIVED from the numbers above so they can never drift
    // apart again. They were independent constants (5 / 1.6) until
    // 2026-08-14, when the bot legally opened a BTC short with 4.5 CELO,
    // fell under the exit gate the same evening, could not keep the stop
    // armed, and the trade ran ~6x past it -- 59% of the experiment's
    // losses in one position. An entry must now leave behind enough to
    // re-arm both exit legs AND market-close what it is about to open.
    minCeloForEntry: celo(
      KEEPER_FEE_CELO * (ENTRY_ORDERS + EXIT_RESERVE_ORDERS) + FEE_MARGIN_CELO,
    ),
    minCeloForExit: celo(KEEPER_FEE_CELO + FEE_MARGIN_CELO),
    // Measured over the first 13 live round trips: ~21.4 CELO in, 4.17 left.
    // Refunds are partial, so roughly one keeper fee is burned per trip.
    celoPerRoundTrip: 1.3,
    minCeloRunwayTrips: 6,
    minFreeUsdt: 2,
    maxTxPerRun: 8,
    stuckOrderMinutes: 45,
    positionPollAttempts: 16,
    positionPollDelayMs: 15000,
    simSlippageBps: 30,
    // Estimated protocol open+close fee, subtracted from simulated/estimated PnL.
    roundTripFeeRate: 0.002,
  },
}

// The weekly auto-tune loop writes state/tuning.json; overrides are merged here
// so every consumer sees one config. Unknown or out-of-bounds keys are dropped
// by src/tuning.js, and `risk` is deliberately NOT tunable -- the loop may
// change how the bot trades, never the gates that stop it losing more than it
// should.
const activeTuning = tuning.load()
module.exports = {
  ...base,
  sleeves: tuning.apply(base.sleeves, activeTuning),
  tuning: activeTuning,
}
