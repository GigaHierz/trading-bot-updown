const test = require('node:test')
const assert = require('node:assert/strict')

test('reporting is disabled unless a URL is explicitly configured', () => {
  const previousTrade = process.env.TRADE_REPORT_API_URL
  const previousSetup = process.env.TRADE_SETUP_API_URL
  delete process.env.TRADE_REPORT_API_URL
  delete process.env.TRADE_SETUP_API_URL
  const reporter = require('../scripts/lib/report-trade')
  assert.equal(reporter.getTradeReportUrl(), '')
  assert.equal(reporter.getSetupReportUrl(), '')
  if (previousTrade === undefined) delete process.env.TRADE_REPORT_API_URL
  else process.env.TRADE_REPORT_API_URL = previousTrade
  if (previousSetup === undefined) delete process.env.TRADE_SETUP_API_URL
  else process.env.TRADE_SETUP_API_URL = previousSetup
})
