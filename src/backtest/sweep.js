// Parameter sweep support.
//
// Two rules are baked in rather than left optional, because without them a
// sweep is curve-fitting with extra steps:
//   1. Every cell is scored across several seeds of the cadence sampler, so a
//      winner cannot be one lucky poll sequence.
//   2. Cells whose |t| < 2 or whose trade count is small are flagged in the
//      output, not silently ranked alongside significant ones.

const MAX_CELLS = 200

// 'A.tpPct=0.03,0.06;A.timeStopHours=24,48' -> [{ label, A:{...}, B:{...} }]
function expandGrid(spec, { maxCells = MAX_CELLS } = {}) {
  const axes = String(spec)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [lhs, rhs] = part.split('=')
      if (!rhs) throw new Error(`Malformed sweep axis: "${part}" (expected sleeve.param=v1,v2)`)
      const [sleeve, param] = lhs.trim().split('.')
      if (sleeve !== 'A' && sleeve !== 'B') {
        throw new Error(`Sweep axis must start with A. or B.: "${part}"`)
      }
      const values = rhs.split(',').map((v) => {
        const n = Number(v)
        if (Number.isNaN(n)) throw new Error(`Non-numeric sweep value "${v}" in "${part}"`)
        return n
      })
      return { sleeve, param, values }
    })

  const total = axes.reduce((a, ax) => a * ax.values.length, 1)
  if (total > maxCells) {
    throw new Error(`Sweep would run ${total} cells; cap is ${maxCells}. Narrow the grid.`)
  }

  let cells = [{ label: [], A: {}, B: {} }]
  for (const ax of axes) {
    const next = []
    for (const cell of cells) {
      for (const v of ax.values) {
        next.push({
          label: [...cell.label, `${ax.sleeve}.${ax.param}=${v}`],
          A: { ...cell.A, ...(ax.sleeve === 'A' ? { [ax.param]: v } : {}) },
          B: { ...cell.B, ...(ax.sleeve === 'B' ? { [ax.param]: v } : {}) },
        })
      }
    }
    cells = next
  }
  return cells.map((c) => ({ ...c, label: c.label.join(' ') }))
}

function flags(cell, minTrades) {
  const out = []
  if (cell.trades < minTrades) out.push(`⚠ n=${cell.trades}`)
  if (cell.stdErr && Math.abs(cell.expectancy / cell.stdErr) < 2) out.push('⚠ |t|<2')
  if (cell.worstNet < 0 && cell.net > 0) out.push('⚠ seed-fragile')
  return out.join(' ')
}

function rankCells(cells, baseline = null, { metric = 'expectancyBps', minTrades = 30 } = {}) {
  return [...cells]
    .sort((a, b) => b[metric] - a[metric])
    .map((c) => ({
      ...c,
      delta: baseline ? Math.round((c[metric] - baseline[metric]) * 100) / 100 : null,
      flags: flags(c, minTrades),
    }))
}

function formatTable(ranked, baseline = null) {
  const lines = []
  lines.push('| params | trades | win rate | edge bps/trade | Δ bps | net USD | worst seed | flags |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|')
  if (baseline) {
    lines.push(
      `| _baseline (current config)_ | ${baseline.trades} | ` +
        `${baseline.winRate === null ? 'n/a' : (baseline.winRate * 100).toFixed(1) + '%'} | ` +
        `${baseline.expectancyBps} | — | ${baseline.net >= 0 ? '+' : ''}${baseline.net} | ` +
        `${baseline.worstNet} | |`,
    )
  }
  for (const c of ranked) {
    lines.push(
      `| ${c.label} | ${c.trades} | ` +
        `${c.winRate === null ? 'n/a' : (c.winRate * 100).toFixed(1) + '%'} | ` +
        `${c.expectancyBps} | ` +
        `${c.delta === null ? '—' : (c.delta >= 0 ? '+' : '') + c.delta} | ` +
        `${c.net >= 0 ? '+' : ''}${c.net} | ${c.worstNet} | ${c.flags} |`,
    )
  }
  lines.push('')
  lines.push(
    '_A flagged row is not a recommendation. ⚠ |t|<2 means the cell is ' +
      'indistinguishable from zero; ⚠ seed-fragile means it only wins on some ' +
      'poll sequences._',
  )
  return lines.join('\n')
}

module.exports = { expandGrid, rankCells, formatTable, MAX_CELLS }
