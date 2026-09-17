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
    gas: initialGas(),
  }
}

// CELO execution-fee accounting, so runway can be forecast instead of only
// discovered at the floor. Keeper fees are prepaid and partially refunded, so
// the raw balance sawtooths within a single round trip; only increases that
// cannot be a refund are counted as external top-ups, and net burn is then
// (first + topUps - last).
function initialGas() {
  return {
    firstBalance: null,
    firstSampleAt: null,
    lastBalance: null,
    lastSampleAt: null,
    hadExposure: false,
    topUpsCelo: 0,
  }
}

const round4 = (n) => Math.round(n * 1e4) / 1e4

function recordGasSample(
  state,
  { celoBalance, hasExposure = false, maxRefundCelo = Infinity },
  now = new Date(),
) {
  if (typeof celoBalance !== 'number' || !Number.isFinite(celoBalance)) return
  const gas = state.gas || (state.gas = initialGas())
  const ts = now.toISOString()

  if (gas.lastBalance !== null) {
    const delta = celoBalance - gas.lastBalance
    // An increase is only a keeper refund if something was actually in flight
    // last time we looked, and it is small enough to be one.
    const couldBeRefund = gas.hadExposure && delta <= maxRefundCelo
    if (delta > 0 && !couldBeRefund) {
      gas.topUpsCelo = round4(gas.topUpsCelo + delta)
    }
  } else {
    gas.firstBalance = celoBalance
    gas.firstSampleAt = ts
  }

  gas.lastBalance = celoBalance
  gas.lastSampleAt = ts
  gas.hadExposure = hasExposure
}

// Net CELO consumed since tracking began, and the burn per closed round trip.
// Returns nulls rather than guesses when there is not enough history yet.
function gasBurn(state, roundTrips = 0) {
  const gas = state.gas
  if (!gas || gas.firstBalance === null || gas.lastBalance === null) {
    return { netBurnCelo: null, perTripCelo: null, perDayCelo: null, days: null }
  }
  const netBurnCelo = round4(gas.firstBalance + gas.topUpsCelo - gas.lastBalance)
  const days = (new Date(gas.lastSampleAt) - new Date(gas.firstSampleAt)) / 864e5
  return {
    netBurnCelo,
    perTripCelo: roundTrips > 0 ? round4(netBurnCelo / roundTrips) : null,
    perDayCelo: days >= 1 ? round4(netBurnCelo / days) : null,
    days: round4(days),
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
  // Forward-compat: state files committed before gas tracking existed.
  if (!raw.gas) raw.gas = initialGas()
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
  initialGas,
  recordGasSample,
  gasBurn,
  load,
  save,
  appendTrade,
  entriesToday,
  recordEntry,
}
