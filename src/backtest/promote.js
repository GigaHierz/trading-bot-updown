// The promotion gate: the only thing standing between a search result and real
// money, given there is no human in the loop.
//
// A search over enough parameter cells will always produce a winner. Almost all
// of those winners are noise -- the best of N random walks looks skilful. These
// rules exist to make "promote nothing" the default outcome and force a
// candidate to earn its way past it.
//
// Rule 6 is the one that matters most for this bot: profitability is measured
// AFTER the full cost stack, because the measured gross edge here is about
// -7bp/trade against a ~117bp round-trip cost. A candidate that is profitable
// gross and unprofitable net is not a candidate.

const DEFAULTS = {
  minOosTrades: 20, // below this, the OOS t-stat is meaningless
  minTStat: 2, // ~95% confidence the edge is not zero
  marginBps: 15, // must beat the incumbent by a real margin, not a rounding
  requireSignAgreement: true, // train and OOS must agree, or it is regime luck
  requireWorstSeedPositive: true, // must survive every cadence draw, not the lucky one
}

// Splits a window into train and out-of-sample halves. The OOS slice is always
// the LATER one: tuning on recent data and validating on older data would leak.
function splitWindow(from, to, oosFrac = 0.3) {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  if (!(b > a)) throw new Error(`Invalid window ${from}..${to}`)
  if (oosFrac <= 0 || oosFrac >= 1) throw new Error(`oosFrac must be in (0,1), got ${oosFrac}`)
  const cut = a + (b - a) * (1 - oosFrac)
  const iso = (t) => new Date(t).toISOString()
  return { trainFrom: iso(a), trainTo: iso(cut), oosFrom: iso(cut), oosTo: iso(b) }
}

function tStatOf(cell) {
  if (!cell || !cell.stdErr || !Number.isFinite(cell.expectancy)) return null
  return cell.expectancy / cell.stdErr
}

// candidate/baseline are scored cells: { trades, expectancyBps, expectancy,
// stdErr, worstNet, net }. `train` is the candidate's in-sample score.
function promotionGate({ candidate, baseline, train = null, opts = {} }) {
  const o = { ...DEFAULTS, ...opts }
  const reasons = []
  const pass = []

  if (!candidate) return { promote: false, reasons: ['no candidate'], passed: [] }

  // 1. Enough out-of-sample trades to say anything at all.
  if (candidate.trades < o.minOosTrades) {
    reasons.push(`OOS n=${candidate.trades} < ${o.minOosTrades}`)
  } else pass.push(`OOS n=${candidate.trades}`)

  // 2. Profitable out of sample, after the full cost stack.
  if (!(candidate.expectancyBps > 0)) {
    reasons.push(`OOS edge ${candidate.expectancyBps} bps/trade is not positive after costs`)
  } else pass.push(`OOS edge +${candidate.expectancyBps} bps/trade`)

  // 3. Significantly POSITIVE, not merely significant. |t| would tick this box
  //    for a candidate that reliably loses money.
  const t = tStatOf(candidate)
  if (t === null || t < o.minTStat) {
    reasons.push(
      `OOS t=${t === null ? 'n/a' : t.toFixed(2)} < +${o.minTStat} ` +
        '(needs to be significantly positive, not just significant)',
    )
  } else pass.push(`OOS t=+${t.toFixed(2)}`)

  // 4. Beats the incumbent by a margin that is not a rounding artifact.
  if (baseline) {
    const delta = candidate.expectancyBps - baseline.expectancyBps
    if (delta < o.marginBps) {
      reasons.push(
        `beats incumbent by only ${delta.toFixed(1)} bps (need ${o.marginBps})`,
      )
    } else pass.push(`+${delta.toFixed(1)} bps vs incumbent`)
  }

  // 5. Survives every cadence draw, not just the lucky one.
  if (o.requireWorstSeedPositive && Number.isFinite(candidate.worstNet)) {
    if (!(candidate.worstNet > 0)) {
      reasons.push(`worst cadence seed still loses (${candidate.worstNet})`)
    } else pass.push(`worst seed +${candidate.worstNet}`)
  }

  // 6. In-sample and out-of-sample agree. A candidate that only works in the
  //    half it was chosen on was chosen BY that half.
  if (o.requireSignAgreement && train) {
    const sameSign = Math.sign(train.expectancyBps) === Math.sign(candidate.expectancyBps)
    if (!sameSign) {
      reasons.push(
        `train ${train.expectancyBps} bps and OOS ${candidate.expectancyBps} bps disagree in sign`,
      )
    } else pass.push('train/OOS agree')
  }

  return { promote: reasons.length === 0, reasons, passed: pass, tStat: t }
}

// Separate question from "is there something better": is what we are running
// right now actively losing money? If the incumbent is significantly negative
// out of sample and nothing beat it, the correct action is to stop trading.
function shouldDisableTrading(baseline, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  if (!baseline || baseline.trades < o.minOosTrades) return { disable: false, reason: null }
  const t = tStatOf(baseline)
  if (baseline.expectancyBps < 0 && t !== null && t < -o.minTStat) {
    return {
      disable: true,
      reason:
        `incumbent config loses ${Math.abs(baseline.expectancyBps).toFixed(1)} bps/trade out of ` +
        `sample (t=${t.toFixed(2)}, n=${baseline.trades}) and nothing in the search space beat it`,
    }
  }
  return { disable: false, reason: null }
}

// After a change has been live for a while, did reality match the backtest?
// Guards against a promotion that was valid offline and wrong in production.
function shouldRollback({ liveCell, predictedBps, opts = {} }) {
  const o = { ...DEFAULTS, ...opts }
  if (!liveCell || liveCell.trades < o.minOosTrades) {
    return { rollback: false, reason: null }
  }
  const t = tStatOf(liveCell)
  if (liveCell.expectancyBps < 0 && t !== null && t < -o.minTStat) {
    return {
      rollback: true,
      reason:
        `live edge since the change is ${liveCell.expectancyBps} bps/trade ` +
        `(t=${t.toFixed(2)}, n=${liveCell.trades}) against a predicted ${predictedBps}`,
    }
  }
  return { rollback: false, reason: null }
}

module.exports = { DEFAULTS, splitWindow, promotionGate, shouldDisableTrading, shouldRollback, tStatOf }
