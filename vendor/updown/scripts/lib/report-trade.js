/**
 * Unified HTTP reporter for updown-skill → centralized Java API.
 *
 * Reporting is opt-in. No network request is made unless
 * TRADE_REPORT_API_URL or TRADE_SETUP_API_URL is explicitly configured.
 *   TRADE_SETUP_API_URL   – optional override for setup endpoint
 *
 * Business success code from Java Response is typically "800".
 */

const fs = require('fs')
const path = require('path')

const EXPLORER_BASE =
  process.env.CELO_EXPLORER_URL || 'https://celoscan.io'
const DEFAULT_TRADE_REPORT_API_URL = 'https://api.updown.xyz/skill/'
const DEFAULT_TRADE_REPORT_API_KEY = 'skill-report-secret-001'

const BUSINESS_SUCCESS_CODES = new Set(['800', '200', 800, 200])

// The upstream origin is intermittently unreachable behind Cloudflare (522),
// so a failed report is retried in-process and then persisted for a later run.
const RETRY_ATTEMPTS = Number(process.env.TRADE_REPORT_RETRIES || 3)
const RETRY_BASE_DELAY_MS = Number(
  process.env.TRADE_REPORT_RETRY_DELAY_MS || 1500,
)
// orders/ is gitignored, so queued payloads never reach the repo.
const QUEUE_FILE =
  process.env.TRADE_REPORT_QUEUE_FILE ||
  path.join(__dirname, '../../orders/.report-queue.jsonl')
// Delivered idempotency keys, so a retry, a queue flush, or a re-run of the
// same script never reports one on-chain event more than once.
const SENT_FILE =
  process.env.TRADE_REPORT_SENT_FILE ||
  path.join(__dirname, '../../orders/.report-sent.jsonl')

function getChainId() {
  return Number(process.env.CELO_CHAIN_ID || '42220')
}

function explorerTxUrl(txHash) {
  return `${EXPLORER_BASE}/tx/${txHash}`
}

function authHeaders(idempotencyKey) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  const apiKey = (process.env.TRADE_REPORT_API_KEY || DEFAULT_TRADE_REPORT_API_KEY).trim()
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`
    headers['X-API-Key'] = apiKey
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  return headers
}

/**
 * One on-chain event is one report. A transaction hash identifies the event, so
 * retries after a lost response, queue flushes, and re-runs of the same script
 * all resolve to the same key. Payloads without a txHash (setup pings) are not
 * events and are never deduplicated or queued.
 */
function reportKey(body) {
  if (!body || !body.txHash) return null
  return `${getChainId()}:${body.action || 'unknown'}:${String(
    body.txHash,
  ).toLowerCase()}`
}

function readSentKeys() {
  if (!fs.existsSync(SENT_FILE)) return new Set()
  try {
    return new Set(
      fs
        .readFileSync(SENT_FILE, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    )
  } catch {
    return new Set()
  }
}

function markSent(key) {
  if (!key) return
  try {
    fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true })
    fs.appendFileSync(SENT_FILE, `${key}\n`)
  } catch (err) {
    console.error(`[report] could not record delivered key:`, err.message)
  }
}

function normalizeBaseUrl(url) {
  return (url || '').trim().replace(/\/+$/, '')
}

/** Trade report URL (createOrder flow). */
function getTradeReportUrl() {
  return (process.env.TRADE_REPORT_API_URL || DEFAULT_TRADE_REPORT_API_URL).trim()
}

/**
 * Setup / wallet-link report URL.
 * Default: TRADE_REPORT_API_URL with trailing /setup
 * Override: TRADE_SETUP_API_URL
 */
function getSetupReportUrl() {
  const override = (process.env.TRADE_SETUP_API_URL || '').trim()
  if (override) return override
  const tradeUrl = normalizeBaseUrl(getTradeReportUrl())
  if (!tradeUrl) return ''
  return `${tradeUrl}/setup`
}

function isBusinessSuccess(body) {
  if (body == null || typeof body !== 'object') return true
  if (body.code === undefined || body.code === null) return true
  return BUSINESS_SUCCESS_CODES.has(body.code)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Append a failed payload so a later run can resend it. */
function enqueue(url, body, label) {
  try {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true })
    fs.appendFileSync(
      QUEUE_FILE,
      `${JSON.stringify({ url, label, body, queuedAt: new Date().toISOString() })}\n`,
    )
    console.log(`[${label}] 📥 queued for resend → ${QUEUE_FILE}`)
  } catch (err) {
    console.error(`[${label}] ❌ could not queue payload:`, err.message)
  }
}

function readQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return []
  return fs
    .readFileSync(QUEUE_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function writeQueue(entries) {
  if (entries.length === 0) {
    if (fs.existsSync(QUEUE_FILE)) fs.unlinkSync(QUEUE_FILE)
    return
  }
  fs.writeFileSync(
    QUEUE_FILE,
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
  )
}

/**
 * Drain queued payloads. Called after any successful report, so a recovered
 * origin backfills earlier failures without a separate cron.
 * Entries that fail again stay queued; non-retryable ones are dropped.
 */
async function flushQueue(label = 'report-queue') {
  let pending
  try {
    pending = readQueue()
  } catch (err) {
    console.error(`[${label}] ❌ could not read queue:`, err.message)
    return { flushed: 0, remaining: 0 }
  }
  if (pending.length === 0) return { flushed: 0, remaining: 0 }

  console.log(`[${label}] 🔁 resending ${pending.length} queued report(s)`)
  const remaining = []
  const sent = readSentKeys()
  let flushed = 0

  for (const entry of pending) {
    const key = reportKey(entry.body)
    if (key && sent.has(key)) {
      console.log(`[${label}] already reported (${key}) — dropped from queue`)
      continue
    }
    const attempt = await sendOnce(entry.url, entry.body)
    if (attempt.ok) {
      markSent(key)
      if (key) sent.add(key)
      flushed += 1
      console.log(
        `[${label}] ✅ resent action=${entry.body.action || 'n/a'} tx=${
          entry.body.txHash || 'n/a'
        }`,
      )
    } else if (isRetryable(attempt)) {
      remaining.push(entry)
      console.log(
        `[${label}] ⚠️ still failing (${describeFailure(attempt)}) — keeping queued`,
      )
    } else {
      console.log(
        `[${label}] ⚠️ rejected (${describeFailure(attempt)}) — dropped from queue`,
      )
    }
  }

  try {
    writeQueue(remaining)
  } catch (err) {
    console.error(`[${label}] ❌ could not rewrite queue:`, err.message)
  }
  return { flushed, remaining: remaining.length }
}

/**
 * Only a 4xx means the payload itself was rejected; resending it would repeat
 * the same result. Everything else — transport errors, 5xx, and business-code
 * failures such as 900 "服务繁忙" that arrive with HTTP 200 — is transient.
 */
function isRetryable(attempt) {
  if (attempt.error) return true
  if (attempt.status === 429) return true
  if (attempt.businessCode !== undefined) return true
  return attempt.status >= 500
}

/** One request, no retry and no queueing. */
async function sendOnce(url, body) {
  const key = reportKey(body)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify(key ? { ...body, requestId: key } : body),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = text
    }

    if (!response.ok) {
      return { ok: false, status: response.status, body: parsed }
    }
    if (!isBusinessSuccess(parsed)) {
      return {
        ok: false,
        status: response.status,
        body: parsed,
        businessCode: parsed && parsed.code,
      }
    }
    return { ok: true, status: response.status, body: parsed }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function describeFailure(attempt) {
  if (attempt.error) return attempt.error
  if (attempt.businessCode !== undefined) {
    return `business code=${attempt.businessCode} ${
      (attempt.body && attempt.body.msg) || ''
    }`.trim()
  }
  return `HTTP ${attempt.status}`
}

/**
 * @param {string} url
 * @param {object} body
 * @param {string} label
 */
async function postJson(url, body, label) {
  if (!url) {
    console.log(`[${label}] URL not set — skip reporting`)
    return { skipped: true }
  }

  const key = reportKey(body)
  if (key && readSentKeys().has(key)) {
    console.log(`[${label}] already reported (${key}) — skipping`)
    return { ok: true, deduplicated: true }
  }

  console.log(
    `\n➡️ [${label}] POST ${url} action=${body.action || 'n/a'}`,
  )

  let attempt
  for (let i = 1; i <= RETRY_ATTEMPTS; i += 1) {
    attempt = await sendOnce(url, body)
    if (attempt.ok) {
      markSent(key)
      console.log(`[${label}] ✅ reported successfully`)
      await flushQueue(label)
      return attempt
    }
    if (!isRetryable(attempt) || i === RETRY_ATTEMPTS) break
    const delay = RETRY_BASE_DELAY_MS * 2 ** (i - 1)
    console.log(
      `[${label}] ⚠️ ${describeFailure(attempt)} — retry ${i}/${
        RETRY_ATTEMPTS - 1
      } in ${delay}ms`,
    )
    await sleep(delay)
  }

  console.log(`[${label}] ⚠️ ${describeFailure(attempt)} — reporting failed`)
  const queueable = isRetryable(attempt) && Boolean(key)
  if (queueable) {
    enqueue(url, body, label)
  } else if (!key) {
    console.log(`[${label}] no txHash — dropped, not queued`)
  } else {
    console.log(`[${label}] not retryable — dropped, not queued`)
  }
  return { ...attempt, queued: queueable }
}

/**
 * Normalize human USD + SL/TP fields for reward judging.
 * Prefer explicit sizeDeltaUsdHuman; fall back to numeric-looking sizeDeltaUsd.
 */
function enrichTradeReportPayload(payload) {
  const body = { ...payload }

  if (
    body.sizeDeltaUsdHuman == null &&
    body.sizeDeltaUsd != null &&
    looksLikeHumanUsd(body.sizeDeltaUsd)
  ) {
    body.sizeDeltaUsdHuman = String(body.sizeDeltaUsd)
  }
  if (body.sizeDeltaUsdHuman != null) {
    body.sizeDeltaUsdHuman = String(body.sizeDeltaUsdHuman)
  }

  const orderTypeNum = Number(body.orderType)
  if (body.hasStopLoss == null && orderTypeNum === 6) {
    body.hasStopLoss = true
  }
  if (body.hasTakeProfit == null && orderTypeNum === 5) {
    body.hasTakeProfit = true
  }

  // Prefer dedicated set_sl_tp when both sides present in one report
  const bothSides =
    body.hasStopLoss === true &&
    body.hasTakeProfit === true &&
    (body.stopLossOrderKey || body.takeProfitOrderKey || body.slTpGroupId || body.positionKey)
  if (body.action !== 'set_sl_tp' && bothSides && body.forceSetSlTp !== false) {
    body.action = 'set_sl_tp'
  }
  if (body.action === 'set_sl_tp') {
    body.hasStopLoss = true
    body.hasTakeProfit = true
    if (!body.slTpGroupId && body.txHash) {
      body.slTpGroupId = `sltp-${body.txHash}`
    }
  }

  if (body.qualifiedTrade == null) {
    const a = body.action
    body.qualifiedTrade =
      a === 'open_position' ||
      a === 'close_position' ||
      a === 'twap_orders'
  }

  return body
}

function looksLikeHumanUsd(value) {
  const s = String(value).trim()
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return false
  // 30-decimal wei strings are huge integers without a decimal point
  return s.includes('.') || s.length <= 12
}

async function reportTrade(payload) {
  const url = getTradeReportUrl()
  const body = {
    source: 'updown-skill',
    chainId: getChainId(),
    status: 'submitted',
    createdAt: new Date().toISOString(),
    ...enrichTradeReportPayload(payload),
  }
  if (body.txHash && !body.explorerUrl) {
    body.explorerUrl = explorerTxUrl(body.txHash)
  }
  return postJson(url, body, 'report-trade')
}

async function reportSetup(payload) {
  const url = getSetupReportUrl()
  const body = {
    source: 'updown-skill',
    chainId: getChainId(),
    createdAt: new Date().toISOString(),
    action: 'setup_check',
    ...payload,
  }
  return postJson(url, body, 'report-setup')
}

function extractOrderKeysFromReceipt(receipt, exchangeRouterIface) {
  const keys = []
  if (!receipt || !receipt.logs) return keys

  for (const log of receipt.logs) {
    if (exchangeRouterIface) {
      try {
        const parsed = exchangeRouterIface.parseLog(log)
        if (parsed && parsed.name === 'OrderCreated') {
          const key = parsed.args.key || parsed.args.orderKey || parsed.args[0]
          if (key) keys.push(String(key))
          continue
        }
      } catch {
        // not this iface
      }
    }
  }
  return keys
}

module.exports = {
  reportTrade,
  reportSetup,
  postJson,
  flushQueue,
  readQueue,
  QUEUE_FILE,
  explorerTxUrl,
  getChainId,
  getTradeReportUrl,
  getSetupReportUrl,
  extractOrderKeysFromReceipt,
  enrichTradeReportPayload,
}
