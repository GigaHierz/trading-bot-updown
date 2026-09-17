// Pairs the append-only trade log into round trips.
//
// The log has no shared trade id: an entry writes an `open` row (src/index.js)
// and the reconciler writes a separate close row (src/exchange/reconcile.js).
// Pairing is therefore inference, and three properties of the real log have to
// be respected or every downstream number is wrong:
//
//   1. The close row is authoritative for entryPrice and notionalUsd. The open
//      row is written before the keeper fills, and index.js re-anchors both to
//      the oracle fill price afterwards. The 2026-09-03 ETH trip opens at
//      2430.09 and closes reporting 2458.07 -- the difference is cron lag, and
//      it is worth measuring on its own (entrySlipPct).
//   2. `dry` can differ between the two rows of one trip. The first trip in the
//      live log opened in simulation and closed for real; it is neither a live
//      result nor a clean dry one.
//   3. A trip may be open at the end of the window, and a close may appear with
//      no matching open (log truncation, adopted orphan positions).

const OPEN = 'open'

function parseRows(text) {
  const rows = []
  const badLines = []
  const lines = String(text || '').split('\n')
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      rows.push(JSON.parse(trimmed))
    } catch (err) {
      badLines.push({ line: trimmed.slice(0, 200), lineNo: i + 1, error: err.message })
    }
  })
  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts))
  return { rows, badLines }
}

// Collapses the free-text `action` on close rows into a small stable set.
function normalizeExitReason(action) {
  const a = String(action || '')
  if (a === 'tp') return 'tp'
  if (a === 'sl') return 'sl'
  if (a.startsWith('time-stop')) return 'time-stop'
  if (a.startsWith('trend filter')) return 'trend-filter'
  if (a.startsWith('gas-guard')) return 'gas-guard'
  if (a.includes('drawdown halt')) return 'halt'
  if (a === 'closed-unattributed') return 'unattributed'
  return 'other'
}

const key = (r) => `${r.sleeve}|${r.market}|${r.side}`

function modeOf(openRow, closeRow) {
  const o = openRow ? Boolean(openRow.dry) : null
  const c = Boolean(closeRow.dry)
  if (o === null) return c ? 'dry' : 'live'
  if (o !== c) return 'mixed'
  return c ? 'dry' : 'live'
}

function pairRoundTrips(rows) {
  const queues = new Map()
  const trips = []
  const orphanCloses = []

  for (const row of rows) {
    if (row.action === OPEN) {
      if (!queues.has(key(row))) queues.set(key(row), [])
      queues.get(key(row)).push(row)
      continue
    }
    const q = queues.get(key(row))
    const openRow = q && q.length ? q.shift() : null
    if (!openRow) {
      orphanCloses.push(row)
      continue
    }
    trips.push(buildTrip(openRow, row))
  }

  const openTrips = []
  for (const q of queues.values()) {
    for (const openRow of q) openTrips.push(buildOpenTrip(openRow))
  }
  return { trips, openTrips, orphanCloses }
}

function buildTrip(openRow, closeRow) {
  const isLong = closeRow.side === 'long'
  const dir = isLong ? 1 : -1
  // Close row wins: it carries the post-fill truth.
  const entryPrice = closeRow.entryPrice ?? openRow.entryPrice
  const signalPrice = openRow.entryPrice ?? null
  const entrySlipPct =
    signalPrice && entryPrice ? ((entryPrice - signalPrice) / signalPrice) * dir : null
  return {
    sleeve: closeRow.sleeve,
    market: closeRow.market,
    side: closeRow.side,
    isLong,
    openTs: openRow.ts,
    closeTs: closeRow.ts,
    holdHours: (new Date(closeRow.ts) - new Date(openRow.ts)) / 3.6e6,
    mode: modeOf(openRow, closeRow),
    entryPrice,
    exitPrice: closeRow.exitPrice ?? null,
    signalPrice,
    entrySlipPct,
    notionalUsd: closeRow.notionalUsd ?? openRow.notionalUsd ?? null,
    pnlUsd: closeRow.pnlUsd ?? null,
    equityAfter: closeRow.equityAfter ?? null,
    action: closeRow.action,
    exitReason: normalizeExitReason(closeRow.action),
    entryReason: openRow.reason ?? null,
    tpPrice: openRow.tpPrice ?? null,
    slPrice: openRow.slPrice ?? null,
    txHash: openRow.txHash ?? null,
  }
}

function buildOpenTrip(openRow) {
  return {
    sleeve: openRow.sleeve,
    market: openRow.market,
    side: openRow.side,
    isLong: openRow.side === 'long',
    openTs: openRow.ts,
    mode: openRow.dry ? 'dry' : 'live',
    entryPrice: openRow.entryPrice ?? null,
    notionalUsd: openRow.notionalUsd ?? null,
    tpPrice: openRow.tpPrice ?? null,
    slPrice: openRow.slPrice ?? null,
    entryReason: openRow.reason ?? null,
    txHash: openRow.txHash ?? null,
  }
}

module.exports = { parseRows, pairRoundTrips, normalizeExitReason }
