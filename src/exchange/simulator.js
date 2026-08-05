const config = require('../config')

// Dry-run twin of the live adapter. Positions live only in state; fills are
// modeled at the reference price plus a fixed impact, and TP/SL are evaluated
// against candle ranges by the reconciler.
function createSimulator({ state, prices }) {
  const slip = config.risk.simSlippageBps / 10000

  return {
    dry: true,

    async snapshot() {
      const positions = []
      for (const [name, sleeve] of Object.entries(state.sleeves)) {
        for (const [market, p] of Object.entries(sleeve.positions)) {
          if (p.status === 'open') {
            positions.push({
              market,
              isLong: p.isLong,
              sizeUsd: p.notionalUsd,
              collateralUsd: p.collateralUsd,
              sleeve: name,
            })
          }
        }
      }
      return {
        account: 'simulator',
        celoBalance: null,
        wusdtBalance: null,
        positions,
        orders: [],
        prices,
        minPositionSizeUsd: null,
      }
    },

    async openPosition(intent) {
      const dir = intent.isLong ? 1 : -1
      const fill = intent.refPrice * (1 + dir * slip)
      return {
        orderKey: `sim-${state.sim.nextId++}`,
        txHash: null,
        fillPrice: fill,
      }
    },

    async placeExit() {
      return { orderKey: `sim-${state.sim.nextId++}`, txHash: null }
    },

    async closeMarket({ market }) {
      const price = prices[market]
      const fill = price // exit impact folded into roundTripFeeRate
      return { orderKey: null, txHash: null, fillPrice: fill }
    },

    async cancelOrder() {
      return { txHash: null }
    },

    async waitForPosition({ market, isLong }) {
      return { market, isLong, simulated: true }
    },
  }
}

module.exports = { createSimulator }
