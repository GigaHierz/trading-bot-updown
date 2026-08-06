require('dotenv').config({ quiet: true })

const config = require('./config')
const store = require('./state/store')
const { getCandles } = require('./data/candles')
const sleeveA = require('./strategy/sleeveA')
const sleeveB = require('./strategy/sleeveB')
const { filterIntents, applyDrawdownHalt } = require('./risk')
const { createSimulator } = require('./exchange/simulator')
const { reconcile, realize } = require('./exchange/reconcile')
const { log, summary, flushSummary } = require('./log')

async function main() {
  if ((process.env.BOT_ENABLED || 'true') === 'false') {
    log('BOT_ENABLED=false — kill switch active, exiting.')
    return
  }
  const dry = (process.env.DRY_RUN || 'true') !== 'false'
  summary(`## UPDOWN bot run ${new Date().toISOString()} ${dry ? '(DRY RUN)' : '(LIVE)'}`)

  const state = store.load()
  const symbols = [
    ...new Set([...config.sleeveMarkets.A, ...config.sleeveMarkets.B]),
  ]

  // Candles at each sleeve's own timeframe.
  const candlesByMarket = {}
  for (const market of config.sleeveMarkets.A) {
    candlesByMarket[market] = await getCandles(market, config.sleeves.A.interval)
  }
  for (const market of config.sleeveMarkets.B) {
    candlesByMarket[market] = await getCandles(market, config.sleeves.B.interval)
  }
  const prices = {}
  for (const market of symbols) {
    const c = candlesByMarket[market]
    prices[market] = c[c.length - 1].c
  }

  let adapter
  if (dry) {
    adapter = createSimulator({ state, prices })
  } else {
    if (!process.env.CELO_RPC_URL || !process.env.CELO_PRIVATE_KEY) {
      throw new Error('LIVE mode requires CELO_RPC_URL and CELO_PRIVATE_KEY')
    }
    const live = require('./exchange/updown')
    adapter = { dry: false, ...live, snapshot: () => live.snapshot(symbols) }
  }

  const snap = await adapter.snapshot()
  if (snap.celoBalance !== null) {
    summary(
      `Wallet: CELO ${snap.celoBalance.toFixed(2)}, wUSDT ${snap.wusdtBalance.toFixed(2)}, ` +
        `${snap.positions.length} position(s), ${snap.orders.length} pending order(s)`,
    )
  }

  await reconcile({ state, snap, candlesByMarket, adapter, now: Date.now() })

  if (applyDrawdownHalt(state)) {
    summary(
      `🛑 Sleeve B hit its ${(config.sleeves.B.haltFraction * 100).toFixed(0)}% drawdown floor — halted permanently`,
    )
  }

  const now = new Date()
  const intents = [
    ...sleeveA.tick({ candlesByMarket, sleeve: state.sleeves.A, now }),
    ...sleeveB.tick({ candlesByMarket, sleeve: state.sleeves.B, now }),
  ]

  // Live positions must always carry on-exchange TP+SL; re-arm missing legs.
  if (!dry) {
    for (const [name, sleeve] of Object.entries(state.sleeves)) {
      for (const [market, record] of Object.entries(sleeve.positions)) {
        if (record.status !== 'open') continue
        if (record.hasTpOnChain === false) {
          intents.push({ kind: 'protect', leg: 'tp', sleeve: name, market })
        }
        if (record.hasSlOnChain === false) {
          intents.push({ kind: 'protect', leg: 'sl', sleeve: name, market })
        }
      }
    }
  }

  const { allowed, skipped } = filterIntents({ intents, snapshot: snap, state })
  for (const s of skipped) {
    summary(`⏭️ skipped ${s.intent.kind} ${s.intent.sleeve}/${s.intent.market}: ${s.reason}`)
  }

  let txCount = 0
  for (const intent of allowed) {
    if (txCount >= config.risk.maxTxPerRun) {
      summary(`⏭️ tx budget (${config.risk.maxTxPerRun}) exhausted; deferring remaining intents`)
      break
    }
    try {
      if (intent.kind === 'open') {
        txCount += await executeOpen({ adapter, dry, state, intent, symbols })
      } else if (intent.kind === 'close') {
        txCount += await executeClose({ adapter, dry, state, intent, prices })
      } else if (intent.kind === 'protect') {
        txCount += await executeProtect({ adapter, state, intent })
      }
    } catch (err) {
      summary(`❌ ${intent.kind} ${intent.sleeve}/${intent.market} failed: ${String(err.message).slice(0, 300)}`)
    }
  }

  for (const [name, sleeve] of Object.entries(state.sleeves)) {
    const marks = Object.entries(sleeve.positions)
      .filter(([, p]) => p.status === 'open')
      .map(([market, p]) => {
        const dir = p.isLong ? 1 : -1
        const upnl = p.notionalUsd * ((prices[market] - p.entryPrice) / p.entryPrice) * dir
        return `${market} ${p.isLong ? 'long' : 'short'} uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}`
      })
    summary(
      `Sleeve ${name} (${config.sleeves[name].label}): equity ${sleeve.equity.toFixed(2)} USD` +
        `${sleeve.halted ? ' [HALTED]' : ''}${marks.length ? ' | ' + marks.join(', ') : ''}`,
    )
  }

  store.save(state)
  flushSummary()
}

async function executeOpen({ adapter, dry, state, intent, symbols }) {
  const sleeve = state.sleeves[intent.sleeve]
  let tx = 1

  const res = await adapter.openPosition(intent)
  const record = {
    status: dry ? 'open' : 'pending_open',
    isLong: intent.isLong,
    notionalUsd: intent.notionalUsd,
    collateralUsd: intent.collateralUsd,
    entryPrice: res.fillPrice || intent.refPrice,
    tpPrice: round6(intent.tpPrice),
    slPrice: round6(intent.slPrice),
    openedAt: new Date().toISOString(),
    openOrderKey: res.orderKey,
  }
  sleeve.positions[intent.market] = record
  store.recordEntry(sleeve)
  sleeve.lastSignalBar[intent.market] = intent.signalBarTs

  store.appendTrade({
    sleeve: intent.sleeve,
    market: intent.market,
    side: intent.isLong ? 'long' : 'short',
    action: 'open',
    notionalUsd: intent.notionalUsd,
    entryPrice: record.entryPrice,
    tpPrice: record.tpPrice,
    slPrice: record.slPrice,
    reason: intent.reason,
    txHash: res.txHash || null,
    dry,
  })
  summary(
    `📈 ${intent.sleeve}/${intent.market} ${intent.isLong ? 'LONG' : 'SHORT'} ` +
      `${intent.notionalUsd} USD @ ~${record.entryPrice} (TP ${record.tpPrice} / SL ${record.slPrice}) — ${intent.reason}`,
  )

  if (!dry) {
    const pos = await adapter.waitForPosition({
      market: intent.market,
      isLong: intent.isLong,
      symbols,
    })
    if (pos && !pos.simulated) {
      record.status = 'open'
      record.notionalUsd = pos.sizeUsd || record.notionalUsd
      record.collateralUsd = pos.collateralUsd || record.collateralUsd
    }
    if (record.status === 'open' || pos) {
      const tp = await adapter.placeExit({
        market: intent.market,
        isLong: intent.isLong,
        kind: 'tp',
        triggerPrice: record.tpPrice,
      })
      record.tpOrderKey = tp.orderKey
      record.hasTpOnChain = true
      tx += 1
      const sl = await adapter.placeExit({
        market: intent.market,
        isLong: intent.isLong,
        kind: 'sl',
        triggerPrice: record.slPrice,
      })
      record.slOrderKey = sl.orderKey
      record.hasSlOnChain = true
      tx += 1
      summary(`🛡️ ${intent.sleeve}/${intent.market}: on-exchange TP+SL placed`)
    } else {
      summary(
        `⚠️ ${intent.sleeve}/${intent.market}: keeper has not executed the entry yet — TP/SL will be placed next run`,
      )
    }
  }
  return tx
}

async function executeClose({ adapter, dry, state, intent, prices }) {
  const sleeve = state.sleeves[intent.sleeve]
  const record = sleeve.positions[intent.market]
  if (!record || record.status === 'closing') return 0

  const res = await adapter.closeMarket({ market: intent.market, isLong: record.isLong })
  if (dry) {
    realize({
      state,
      sleeveName: intent.sleeve,
      market: intent.market,
      record,
      exitPrice: res.fillPrice ?? prices[intent.market],
      action: intent.reason,
      dry: true,
    })
  } else {
    record.status = 'closing'
    record.closeReason = intent.reason
    summary(`📉 ${intent.sleeve}/${intent.market}: market close submitted (${intent.reason})`)
  }
  return 1
}

async function executeProtect({ adapter, state, intent }) {
  const record = state.sleeves[intent.sleeve].positions[intent.market]
  if (!record) return 0
  const res = await adapter.placeExit({
    market: intent.market,
    isLong: record.isLong,
    kind: intent.leg,
    triggerPrice: intent.leg === 'tp' ? record.tpPrice : record.slPrice,
  })
  if (intent.leg === 'tp') {
    record.tpOrderKey = res.orderKey
    record.hasTpOnChain = true
  } else {
    record.slOrderKey = res.orderKey
    record.hasSlOnChain = true
  }
  summary(`🛡️ ${intent.sleeve}/${intent.market}: re-armed missing ${intent.leg.toUpperCase()}`)
  return 1
}

function round6(x) {
  return Number(Number(x).toPrecision(8))
}

main().catch((err) => {
  console.error(`Run failed: ${err.message}`)
  flushSummary()
  process.exitCode = 1
})
