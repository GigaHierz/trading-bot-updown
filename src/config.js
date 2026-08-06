// Every strategy/risk tunable in one place.
module.exports = {
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
    // Each keeper order prepays >=1.4 CELO execution fee (refunded on
    // execution/cancel). Entry = open + TP + SL = 3 orders in flight.
    minCeloForEntry: 5,
    minCeloForExit: 1.6,
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
