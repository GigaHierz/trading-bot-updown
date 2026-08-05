const fs = require('fs')
const path = require('path')

// Overridable so tests never touch the committed state files.
const STATE_DIR =
  process.env.UPDOWN_STATE_DIR || path.join(__dirname, '../../state')
const STATE_PATH = path.join(STATE_DIR, 'state.json')
const TRADES_PATH = path.join(STATE_DIR, 'trades.ndjson')

function initialState() {
  return {
    version: 1,
    lastRunAt: null,
    sleeves: {
      A: initialSleeve(10),
      B: initialSleeve(10),
    },
    // Simulator-only book of open positions, keyed like live ones.
    sim: { nextId: 1 },
  }
}

function initialSleeve(equity) {
  return {
    equity,
    initialEquity: equity,
    highWaterMark: equity,
    halted: false,
    // market -> position record
    positions: {},
    tradesToday: { date: null, count: 0 },
    lastSignalBar: {},
  }
}

function load() {
  if (!fs.existsSync(STATE_PATH)) return initialState()
  const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  if (raw.version !== 1) throw new Error(`Unknown state version: ${raw.version}`)
  return raw
}

function save(state) {
  state.lastRunAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true })
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

function appendTrade(row) {
  fs.mkdirSync(path.dirname(TRADES_PATH), { recursive: true })
  fs.appendFileSync(
    TRADES_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n',
  )
}

function entriesToday(sleeve, now = new Date()) {
  const today = now.toISOString().slice(0, 10)
  if (sleeve.tradesToday.date !== today) return 0
  return sleeve.tradesToday.count
}

function recordEntry(sleeve, now = new Date()) {
  const today = now.toISOString().slice(0, 10)
  if (sleeve.tradesToday.date !== today) {
    sleeve.tradesToday = { date: today, count: 0 }
  }
  sleeve.tradesToday.count += 1
}

module.exports = {
  STATE_PATH,
  TRADES_PATH,
  initialState,
  initialSleeve,
  load,
  save,
  appendTrade,
  entriesToday,
  recordEntry,
}
