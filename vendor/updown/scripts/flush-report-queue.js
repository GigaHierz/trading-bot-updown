/**
 * Resend reports that failed while the upstream origin was unreachable.
 *
 *   node scripts/flush-report-queue.js          # resend everything queued
 *   node scripts/flush-report-queue.js --list   # show queue without sending
 *
 * The queue is also drained automatically after any successful report.
 */

const path = require('path')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const { flushQueue, readQueue, QUEUE_FILE } = require('./lib/report-trade')

async function main() {
  const entries = readQueue()
  console.log(`queue file: ${QUEUE_FILE}`)
  console.log(`queued reports: ${entries.length}\n`)

  for (const [i, entry] of entries.entries()) {
    console.log(
      `#${i + 1} action=${entry.body.action || 'n/a'} tx=${
        entry.body.txHash || 'n/a'
      } queuedAt=${entry.queuedAt}`,
    )
  }

  if (process.argv.includes('--list')) return
  if (entries.length === 0) return

  console.log('')
  const result = await flushQueue('report-queue')
  console.log(
    `\nflushed: ${result.flushed}, still queued: ${result.remaining}`,
  )
  if (result.remaining > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
