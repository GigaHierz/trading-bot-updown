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
          reason: `CELO balance ${snapshot.celoBalance?.toFixed(2)} < ${risk.minCeloForEntry} needed for entry (3 keeper orders)`,
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

// Sleeve B capital-protection rule: at or below the floor, halt for good.
function applyDrawdownHalt(state) {
  const sleeve = state.sleeves.B
  const floor = sleeve.initialEquity * config.sleeves.B.haltFraction
  if (!sleeve.halted && sleeve.equity <= floor) {
    sleeve.halted = true
    return true
  }
  return false
}

module.exports = { filterIntents, applyDrawdownHalt }
