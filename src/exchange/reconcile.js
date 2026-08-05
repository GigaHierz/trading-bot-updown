const config = require('../config')
const store = require('../state/store')
const { log, summary } = require('../log')

// Order types (GMX): 2 MarketIncrease, 4 MarketDecrease, 5 LimitDecrease (TP),
// 6 StopLossDecrease (SL).

// Brings state in line with reality. On-chain (or the sim candle history) is
// the source of truth; state records are corrected, fills realized into
// sleeve equity, and stuck keeper orders cleaned up.
async function reconcile({ state, snap, candlesByMarket, adapter, now }) {
  const actions = []

  for (const [name, sleeve] of Object.entries(state.sleeves)) {
    for (const [market, record] of Object.entries({ ...sleeve.positions })) {
      if (adapter.dry) {
        reconcileSim({ state, name, sleeve, market, record, candlesByMarket, now })
        continue
      }

      const onChain = snap.positions.find(
        (p) => p.market === market && p.isLong === record.isLong,
      )

      if (record.status === 'pending_open') {
        if (onChain) {
          record.status = 'open'
          record.notionalUsd = onChain.sizeUsd
          record.collateralUsd = onChain.collateralUsd
          log(`reconcile: ${name}/${market} entry executed by keeper`)
        } else {
          const pendingIncrease = snap.orders.find(
            (o) => o.market === market && o.isLong === record.isLong && o.orderType === 2,
          )
          const ageMin = (now - new Date(record.openedAt)) / 60000
          if (!pendingIncrease && ageMin > 5) {
            // Order vanished without a position: cancelled or failed. Roll back.
            delete sleeve.positions[market]
            summary(`⚠️ ${name}/${market}: entry order disappeared without fill — rolled back`)
          } else if (pendingIncrease && ageMin > config.risk.stuckOrderMinutes) {
            actions.push({ kind: 'cancel', orderKey: pendingIncrease.key })
            delete sleeve.positions[market]
            summary(`⚠️ ${name}/${market}: entry stuck ${Math.round(ageMin)}min — cancelling`)
          }
        }
        continue
      }

      if ((record.status === 'open' || record.status === 'closing') && !onChain) {
        // Position closed between runs (TP, SL, manual close, or liquidation).
        const price = snap.prices[market]
        const exit = attributeExit({ record, price })
        realize({ state, sleeveName: name, market, record, exitPrice: exit.price, action: exit.action, dry: false })
        continue
      }

      if (record.status === 'open' && onChain) {
        // Keep exit-order bookkeeping honest: note which legs are resident.
        record.hasTpOnChain = snap.orders.some(
          (o) => o.market === market && o.isLong === record.isLong && o.orderType === 5,
        )
        record.hasSlOnChain = snap.orders.some(
          (o) => o.market === market && o.isLong === record.isLong && o.orderType === 6,
        )
      }
    }
  }

  if (!adapter.dry) {
    adoptOrphans({ state, snap })
    cleanOrphanExitOrders({ snap, state, actions, now })
  }

  for (const action of actions) {
    if (action.kind === 'cancel') {
      try {
        await adapter.cancelOrder(action.orderKey)
        log(`cancelled stuck order ${action.orderKey.slice(0, 10)}…`)
      } catch (err) {
        summary(`⚠️ failed to cancel order: ${err.message.slice(0, 200)}`)
      }
    }
  }
}

// Dry-run: walk candles since entry and fill TP/SL off the bar ranges.
// If a bar touches both, assume the stop filled first (conservative).
function reconcileSim({ state, name, sleeve, market, record, candlesByMarket, now }) {
  if (record.status !== 'open') return
  const candles = candlesByMarket[market] || []
  const since = new Date(record.openedAt).getTime()
  const dir = record.isLong ? 1 : -1

  for (const bar of candles) {
    if (bar.t <= since) continue
    const slHit = dir === 1 ? bar.l <= record.slPrice : bar.h >= record.slPrice
    const tpHit = dir === 1 ? bar.h >= record.tpPrice : bar.l <= record.tpPrice
    if (slHit) {
      realize({ state, sleeveName: name, market, record, exitPrice: record.slPrice, action: 'sl', dry: true })
      return
    }
    if (tpHit) {
      realize({ state, sleeveName: name, market, record, exitPrice: record.tpPrice, action: 'tp', dry: true })
      return
    }
  }
}

// The platform auto-cancels sibling TP/SL when a position closes, so we can't
// see which leg fired. Infer from where price sits relative to the triggers.
function attributeExit({ record, price }) {
  const dir = record.isLong ? 1 : -1
  if (record.status === 'closing') {
    return { action: record.closeReason || 'close', price: price ?? record.entryPrice }
  }
  if (record.tpPrice && dir * (price - record.tpPrice) >= -0.005 * record.tpPrice) {
    return { action: 'tp', price: record.tpPrice }
  }
  if (record.slPrice && dir * (price - record.slPrice) <= 0.005 * record.slPrice) {
    return { action: 'sl', price: record.slPrice }
  }
  return { action: 'closed-unattributed', price: price ?? record.entryPrice }
}

function realize({ state, sleeveName, market, record, exitPrice, action, dry }) {
  const sleeve = state.sleeves[sleeveName]
  const dir = record.isLong ? 1 : -1
  const gross = record.notionalUsd * ((exitPrice - record.entryPrice) / record.entryPrice) * dir
  const fees = record.notionalUsd * config.risk.roundTripFeeRate
  const pnl = round2(gross - fees)
  sleeve.equity = round2(sleeve.equity + pnl)
  sleeve.highWaterMark = Math.max(sleeve.highWaterMark, sleeve.equity)
  delete sleeve.positions[market]

  store.appendTrade({
    sleeve: sleeveName,
    market,
    side: record.isLong ? 'long' : 'short',
    action,
    notionalUsd: record.notionalUsd,
    entryPrice: record.entryPrice,
    exitPrice: round2(exitPrice),
    pnlUsd: pnl,
    equityAfter: sleeve.equity,
    dry,
  })
  summary(
    `${pnl >= 0 ? '🟢' : '🔴'} ${sleeveName}/${market} ${record.isLong ? 'long' : 'short'} ${action}: ` +
      `entry ${record.entryPrice} → exit ${round2(exitPrice)}, PnL ${pnl >= 0 ? '+' : ''}${pnl} USD, equity ${sleeve.equity}`,
  )
}

// A position on-chain that no sleeve record claims (state loss, manual trade):
// adopt it into the owning sleeve by market so it gets managed rather than
// ignored.
function adoptOrphans({ state, snap }) {
  for (const p of snap.positions) {
    if (!p.market) continue
    const sleeveName = config.sleeveMarkets.A.includes(p.market)
      ? 'A'
      : config.sleeveMarkets.B.includes(p.market)
        ? 'B'
        : null
    if (!sleeveName) continue
    const sleeve = state.sleeves[sleeveName]
    if (sleeve.positions[p.market]) continue

    const cfg = config.sleeves[sleeveName]
    const price = snap.prices[p.market]
    const dir = p.isLong ? 1 : -1
    sleeve.positions[p.market] = {
      status: 'open',
      isLong: p.isLong,
      notionalUsd: p.sizeUsd,
      collateralUsd: p.collateralUsd,
      entryPrice: price,
      tpPrice: price * (1 + dir * cfg.tpPct),
      slPrice: price * (1 - dir * cfg.slPct),
      openedAt: new Date().toISOString(),
      adopted: true,
    }
    summary(`⚠️ adopted untracked on-chain position ${sleeveName}/${p.market} (entry marked at current price ${price})`)
  }
}

// TP/SL orders whose position no longer exists should auto-cancel; if one
// lingers past the stuck window, cancel it to reclaim the execution fee.
function cleanOrphanExitOrders({ snap, state, actions, now }) {
  for (const o of snap.orders) {
    if (o.orderType !== 5 && o.orderType !== 6) continue
    const hasPosition = snap.positions.some(
      (p) => p.market === o.market && p.isLong === o.isLong,
    )
    const ageMin = o.updatedAtTime ? (now / 1000 - o.updatedAtTime) / 60 : 0
    if (!hasPosition && ageMin > config.risk.stuckOrderMinutes) {
      actions.push({ kind: 'cancel', orderKey: o.key })
    }
  }
}

function round2(x) {
  return Math.round(x * 100) / 100
}

module.exports = { reconcile, attributeExit, realize }
