// The only fs in src/analytics. Honors UPDOWN_STATE_DIR like src/state/store.
const fs = require('fs')
const path = require('path')
const { parseRows } = require('./roundtrips')

function stateDir() {
  return process.env.UPDOWN_STATE_DIR || path.join(__dirname, '../../state')
}

function loadTradeRows(dir = stateDir()) {
  const file = path.join(dir, 'trades.ndjson')
  if (!fs.existsSync(file)) return { rows: [], badLines: [] }
  return parseRows(fs.readFileSync(file, 'utf8'))
}

function loadState(dir = stateDir()) {
  const file = path.join(dir, 'state.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

module.exports = { stateDir, loadTradeRows, loadState }
