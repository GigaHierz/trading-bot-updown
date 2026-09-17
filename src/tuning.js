// Auto-tuning: the parameter overrides the weekly loop is allowed to apply to
// itself, and the hard bounds it can never leave.
//
// This module must not require ../config -- config.js requires THIS at load to
// merge the overrides in, so the dependency only runs one way.
//
// Everything here is deliberately conservative. The loop edits the config of a
// bot that spends real money with no human in the path, so the blast radius is
// fixed at design time: only whitelisted keys, only inside [min, max], and a
// `tradingEnabled: false` escape hatch the loop can pull on itself when no
// candidate clears the bar.

const fs = require('fs')
const path = require('path')

const STATE_DIR = process.env.UPDOWN_STATE_DIR || path.join(__dirname, '../state')
const TUNING_PATH = path.join(STATE_DIR, 'tuning.json')

// key -> [min, max]. A key absent from here can never be auto-tuned, no matter
// what a search proposes.
const BOUNDS = {
  A: {
    tpPct: [0.01, 0.2],
    slPct: [0.005, 0.1],
    timeStopHours: [4, 240],
    emaFast: [3, 30],
    emaSlow: [10, 120],
    donchian: [6, 96],
    leverage: [1, 3],
    equityFractionPerTrade: [0.1, 0.6],
    maxEntriesPerDay: [1, 6],
    maxConcurrentPositions: [1, 2],
  },
  B: {
    tpPct: [0.005, 0.15],
    slPct: [0.005, 0.08],
    timeStopHours: [8, 336],
    emaFast: [5, 60],
    emaSlow: [20, 200],
    deadZonePct: [0.0005, 0.03],
    leverage: [1, 2],
    maxEntriesPerDay: [1, 4],
  },
}

function initialTuning() {
  return {
    version: 1,
    generation: 0,
    appliedAt: null,
    // When false, the bot takes no new entries. The loop sets this itself when
    // nothing in the search space clears its cost floor -- see auto-tune.js.
    tradingEnabled: true,
    overrides: { A: {}, B: {} },
    evidence: null,
    history: [],
  }
}

function load() {
  try {
    if (!fs.existsSync(TUNING_PATH)) return initialTuning()
    const raw = JSON.parse(fs.readFileSync(TUNING_PATH, 'utf8'))
    if (raw.version !== 1) return initialTuning()
    return { ...initialTuning(), ...raw }
  } catch {
    // A corrupt tuning file must never take the bot down; fall back to the
    // hand-written config.
    return initialTuning()
  }
}

function save(tuning) {
  fs.mkdirSync(path.dirname(TUNING_PATH), { recursive: true })
  fs.writeFileSync(TUNING_PATH, JSON.stringify(tuning, null, 2) + '\n')
}

// Drops unknown keys and clamps known ones. Returns the safe overrides plus a
// list of what it rejected, so the caller can report rather than silently obey.
function sanitize(overrides = {}) {
  const clean = { A: {}, B: {} }
  const rejected = []
  for (const sleeve of ['A', 'B']) {
    for (const [key, value] of Object.entries(overrides[sleeve] || {})) {
      const bound = BOUNDS[sleeve]?.[key]
      if (!bound) {
        rejected.push(`${sleeve}.${key} is not auto-tunable`)
        continue
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        rejected.push(`${sleeve}.${key}=${value} is not a finite number`)
        continue
      }
      const [min, max] = bound
      if (value < min || value > max) {
        rejected.push(`${sleeve}.${key}=${value} outside [${min}, ${max}]`)
        continue
      }
      clean[sleeve][key] = value
    }
  }
  return { overrides: clean, rejected }
}

// Structural invariants a numeric bound cannot express. A config that fails
// these is incoherent regardless of how well it backtested.
function validate(sleeveCfg, sleeveName) {
  const errors = []
  if (sleeveCfg.emaFast >= sleeveCfg.emaSlow) {
    errors.push(`${sleeveName}: emaFast ${sleeveCfg.emaFast} must be < emaSlow ${sleeveCfg.emaSlow}`)
  }
  if (sleeveCfg.tpPct <= sleeveCfg.slPct) {
    errors.push(
      `${sleeveName}: tpPct ${sleeveCfg.tpPct} must exceed slPct ${sleeveCfg.slPct} ` +
        '(a target closer than the stop needs a >50% hit rate to break even)',
    )
  }
  return errors
}

function apply(baseSleeves, tuning = load()) {
  const { overrides } = sanitize(tuning.overrides)
  const out = {}
  for (const [name, cfg] of Object.entries(baseSleeves)) {
    out[name] = { ...cfg, ...(overrides[name] || {}) }
    // A merged config that violates an invariant reverts that sleeve entirely.
    if (validate(out[name], name).length) out[name] = { ...cfg }
  }
  return out
}

module.exports = {
  BOUNDS,
  TUNING_PATH,
  initialTuning,
  load,
  save,
  sanitize,
  validate,
  apply,
}
