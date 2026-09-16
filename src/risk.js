const config = require('./config')

// Applies hard gates to intents. Returns { allowed, skipped: [{intent, reason}] }.
// Close/protect intents are always allowed as long as there is CELO for the
// execution fee — protecting or exiting must never be blocked by entry gates.
function filterIntents({ intents, snapshot, state }) {
  const risk = config.risk
  const allowed = []
  const skipped = []

  for (const intent of intents) {
    if (intent.kind === 'open') {
      const sleeve = state.sleeves[intent.sleeve]
      if (sleeve.halted) {
        skipped.push({ intent, reason: 'sleeve halted' })
        continue
      }
      if (snapshot.celoBalance !== null && snapshot.celoBalance < risk.minCeloForEntry) {
        skipped.push({
          intent,
          reason:
            `CELO balance ${snapshot.celoBalance?.toFixed(2)} < ${risk.minCeloForEntry} needed for entry ` +
            `(${risk.entryOrders} keeper orders + ${risk.exitReserveOrders} reserved to protect/close it)`,
        })
        continue
      }
      if (
        snapshot.wusdtBalance !== null &&
        snapshot.wusdtBalance < intent.collateralUsd + risk.minFreeUsdt
      ) {
        skipped.push({
          intent,
          reason: `free wUSDT ${snapshot.wusdtBalance?.toFixed(2)} too low for ${intent.collateralUsd} collateral`,
        })
        continue
      }
      if (
        snapshot.minPositionSizeUsd !== null &&
        intent.notionalUsd < snapshot.minPositionSizeUsd
      ) {
        skipped.push({
          intent,
          reason: `notional ${intent.notionalUsd} below protocol minimum ${snapshot.minPositionSizeUsd}`,
        })
        continue
      }
      allowed.push(intent)
    } else {
      if (snapshot.celoBalance !== null && snapshot.celoBalance < risk.minCeloForExit) {
        skipped.push({ intent, reason: 'not enough CELO for exit execution fee' })
        continue
      }
      allowed.push(intent)
    }
  }

  return { allowed, skipped }
}

// Counts positions the bot believes it holds on-chain right now.
function countOpenPositions(state) {
  let n = 0
  for (const sleeve of Object.values(state.sleeves)) {
    for (const record of Object.values(sleeve.positions)) {
      if (record.status === 'open' || record.status === 'pending_open') n += 1
    }
  }
  return n
}

// The rule that did not exist on 2026-08-14: never sit on a position you can no
// longer afford to protect. Entry gating alone is not enough, because CELO can
// drain underneath a position that is already open.
//
//   closeCost    = enough to market-close everything held
//   protectFloor = that, plus one stop re-arm per position
//
// Below protectFloor the bot can still act but can no longer guarantee the
// stops stay armed, so the safe move is to close while the gas is still there.
function gasGuard({ snapshot, state }) {
  const risk = config.risk
  const celo = snapshot.celoBalance
  const openPositions = countOpenPositions(state)
  if (typeof celo !== 'number' || !Number.isFinite(celo)) {
    return { level: 'ok', flatten: false, reason: null, openPositions }
  }

  if (openPositions > 0) {
    const closeCost = openPositions * risk.minCeloForExit
    const protectFloor = closeCost + openPositions * risk.keeperFeeCelo
    if (celo < protectFloor) {
      return {
        level: 'critical',
        flatten: true,
        openPositions,
        reason:
          `CELO ${celo.toFixed(2)} below the ${protectFloor.toFixed(2)} needed to keep ` +
          `${openPositions} position(s) protected — closing while gas remains` +
          (celo < closeCost ? ` (below the ${closeCost.toFixed(2)} close cost; may not all succeed)` : ''),
      }
    }
  }

  if (celo < risk.minCeloForEntry) {
    return {
      level: 'warn',
      flatten: false,
      openPositions,
      reason: `CELO ${celo.toFixed(2)} < ${risk.minCeloForEntry} — no new entries until topped up`,
    }
  }
  return { level: 'ok', flatten: false, reason: null, openPositions }
}

// Sleeve B capital-protection rule: at or below the floor, halt for good.
function applyDrawdownHalt(state, cfgB = config.sleeves.B) {
  const sleeve = state.sleeves.B
  const floor = sleeve.initialEquity * cfgB.haltFraction
  if (!sleeve.halted && sleeve.equity <= floor) {
    sleeve.halted = true
    return true
  }
  return false
}

module.exports = { filterIntents, applyDrawdownHalt, gasGuard, countOpenPositions }
