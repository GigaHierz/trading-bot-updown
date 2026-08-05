const fs = require('fs')

// Defensive redaction: any 64-hex substring (a private key shape) is masked
// before anything reaches stdout or the step summary.
function redact(text) {
  return String(text).replace(/(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (m) =>
    // Order keys and tx hashes are 32-byte hex too; keep a recognizable stub.
    `${m.slice(0, 10)}…[hex64]`,
  )
}

const summaryLines = []

function log(...args) {
  console.log(...args.map((a) => (typeof a === 'string' ? redact(a) : a)))
}

function warn(...args) {
  console.warn(...args.map((a) => (typeof a === 'string' ? redact(a) : a)))
}

function summary(line) {
  summaryLines.push(redact(line))
  log(line)
}

function flushSummary() {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file || summaryLines.length === 0) return
  fs.appendFileSync(file, summaryLines.join('\n') + '\n')
}

module.exports = { log, warn, summary, flushSummary, redact }
