process.env.UPDOWN_STATE_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'updown-tune-'),
)

const test = require('node:test')
const assert = require('node:assert')

const tuning = require('../src/tuning')
const {
  splitWindow,
  promotionGate,
  shouldDisableTrading,
  shouldRollback,
  DEFAULTS,
} = require('../src/backtest/promote')

// A candidate that clears every rule. Individual tests break one thing at a
// time, so a rule silently disappearing shows up as a test that stops failing.
const GOOD = { trades: 60, expectancyBps: 40, expectancy: 0.6, stdErr: 0.2, worstNet: 3, net: 8 }
const INCUMBENT = { trades: 55, expectancyBps: 5, expectancy: 0.05, stdErr: 0.2, worstNet: 0.5, net: 1 }
const TRAIN_OK = { expectancyBps: 35 }

const gate = (over = {}, extra = {}) =>
  promotionGate({ candidate: { ...GOOD, ...over }, baseline: INCUMBENT, train: TRAIN_OK, ...extra })

// --- promotion gate -----------------------------------------------------

test('a candidate clearing every rule is promoted', () => {
  const r = gate()
  assert.equal(r.promote, true, r.reasons.join('; '))
})

test('too few out-of-sample trades blocks promotion', () => {
  const r = gate({ trades: DEFAULTS.minOosTrades - 1 })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /OOS n=/)
})

// The rule that matters most here: the gross signal is roughly a coin flip and
// the round trip costs ~117bp, so "profitable" must mean profitable net.
test('a candidate that is not profitable after costs is rejected', () => {
  const r = gate({ expectancyBps: -180, expectancy: -1.8 })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /not positive after costs/)
})

test('significantly NEGATIVE is not mistaken for significant', () => {
  // |t| would pass this; the gate must require a positive t.
  const r = gate({ expectancyBps: -180, expectancy: -1.8, stdErr: 0.2 })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /significantly positive/)
  assert.ok(!r.passed.some((p) => /OOS t=/.test(p)))
})

test('a noisy edge is rejected even when positive', () => {
  const r = gate({ expectancy: 0.6, stdErr: 0.5 }) // t = 1.2
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /< \+2/)
})

test('beating the incumbent by a rounding error is not enough', () => {
  const r = gate({ expectancyBps: INCUMBENT.expectancyBps + DEFAULTS.marginBps - 1 })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /beats incumbent by only/)
})

test('a candidate that only wins on some cadence seeds is rejected', () => {
  const r = gate({ worstNet: -2 })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /worst cadence seed/)
})

test('a candidate that disagrees with its own training half is rejected', () => {
  const r = promotionGate({
    candidate: GOOD,
    baseline: INCUMBENT,
    train: { expectancyBps: -30 },
  })
  assert.equal(r.promote, false)
  assert.match(r.reasons.join(' '), /disagree in sign/)
})

test('no candidate means no promotion', () => {
  assert.equal(promotionGate({ candidate: null, baseline: INCUMBENT }).promote, false)
})

// --- stopping and rolling back -----------------------------------------

test('a significantly losing incumbent triggers a stop', () => {
  const r = shouldDisableTrading({
    trades: 52,
    expectancyBps: -228,
    expectancy: -2.28,
    stdErr: 0.32,
  })
  assert.equal(r.disable, true)
  assert.match(r.reason, /loses 228.0 bps\/trade/)
})

test('a merely unprofitable-looking incumbent on thin data does not', () => {
  assert.equal(shouldDisableTrading({ trades: 5, expectancyBps: -300, expectancy: -3, stdErr: 1 }).disable, false)
  assert.equal(shouldDisableTrading({ trades: 60, expectancyBps: -10, expectancy: -0.1, stdErr: 0.5 }).disable, false)
})

test('live results that contradict the backtest trigger a rollback', () => {
  const r = shouldRollback({
    liveCell: { trades: 40, expectancyBps: -150, expectancy: -1.5, stdErr: 0.3 },
    predictedBps: 40,
  })
  assert.equal(r.rollback, true)
})

test('a rollback needs enough live trades to be sure', () => {
  const r = shouldRollback({
    liveCell: { trades: 3, expectancyBps: -150, expectancy: -1.5, stdErr: 0.3 },
    predictedBps: 40,
  })
  assert.equal(r.rollback, false)
})

// --- window splitting ---------------------------------------------------

test('the out-of-sample slice is always the later one', () => {
  const s = splitWindow('2026-01-01', '2026-11-01', 0.3)
  assert.ok(new Date(s.oosFrom) > new Date(s.trainFrom))
  assert.equal(s.trainTo, s.oosFrom)
  const total = new Date(s.oosTo) - new Date(s.trainFrom)
  const oos = new Date(s.oosTo) - new Date(s.oosFrom)
  assert.ok(Math.abs(oos / total - 0.3) < 0.01)
})

test('splitWindow rejects nonsense windows', () => {
  assert.throws(() => splitWindow('2026-06-01', '2026-01-01'), /Invalid window/)
  assert.throws(() => splitWindow('2026-01-01', '2026-06-01', 0), /oosFrac/)
  assert.throws(() => splitWindow('2026-01-01', '2026-06-01', 1), /oosFrac/)
})

// --- bounds: what the loop may never do to itself -----------------------

test('only whitelisted keys can be auto-tuned', () => {
  const { overrides, rejected } = tuning.sanitize({ A: { tpPct: 0.04, minNotionalUsd: 0.01 } })
  assert.equal(overrides.A.tpPct, 0.04)
  assert.ok(!('minNotionalUsd' in overrides.A))
  assert.match(rejected.join(' '), /not auto-tunable/)
})

test('out-of-bounds values are rejected, not clamped silently into place', () => {
  const { overrides, rejected } = tuning.sanitize({ A: { leverage: 50, tpPct: 99 } })
  assert.deepEqual(overrides.A, {})
  assert.equal(rejected.length, 2)
})

test('non-numeric overrides are rejected', () => {
  const { rejected } = tuning.sanitize({ A: { tpPct: 'aggressive' } })
  assert.match(rejected.join(' '), /not a finite number/)
})

test('risk gates are not tunable at all', () => {
  for (const key of ['minCeloForEntry', 'minCeloForExit', 'roundTripFeeRate', 'maxTxPerRun']) {
    assert.ok(!(key in tuning.BOUNDS.A), `${key} must not be auto-tunable`)
    assert.ok(!(key in tuning.BOUNDS.B), `${key} must not be auto-tunable`)
  }
})

test('an incoherent merged config reverts that sleeve entirely', () => {
  const base = { A: { emaFast: 8, emaSlow: 24, tpPct: 0.06, slPct: 0.025 } }
  // A target inside the stop needs a >50% hit rate just to break even.
  const merged = tuning.apply(base, {
    overrides: { A: { tpPct: 0.01, slPct: 0.05 }, B: {} },
  })
  assert.equal(merged.A.tpPct, 0.06)
  assert.equal(merged.A.slPct, 0.025)
})

test('a crossed EMA pair reverts that sleeve', () => {
  const base = { A: { emaFast: 8, emaSlow: 24, tpPct: 0.06, slPct: 0.025 } }
  const merged = tuning.apply(base, { overrides: { A: { emaFast: 30 }, B: {} } })
  assert.equal(merged.A.emaFast, 8)
})

test('a corrupt tuning file falls back to the hand-written config', () => {
  const fs = require('fs')
  fs.writeFileSync(tuning.TUNING_PATH, 'not json at all')
  const t = tuning.load()
  assert.equal(t.generation, 0)
  assert.equal(t.tradingEnabled, true)
  assert.deepEqual(t.overrides, { A: {}, B: {} })
  fs.unlinkSync(tuning.TUNING_PATH)
})

test('an unknown tuning version is ignored rather than obeyed', () => {
  const fs = require('fs')
  fs.writeFileSync(tuning.TUNING_PATH, JSON.stringify({ version: 99, tradingEnabled: false }))
  assert.equal(tuning.load().tradingEnabled, true)
  fs.unlinkSync(tuning.TUNING_PATH)
})
