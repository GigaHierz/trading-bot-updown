const test = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')

const markets = require('../assets/markets.json')
const tokenMeta = require('../assets/celo-tokens.json')
const {
  generateOrderConfig,
  generateTwapConfigs,
  parseUserInput,
  validateInput,
} = require('../scripts/lib/trade-intent')

test('all configured markets parse case-insensitively', () => {
  for (const market of markets) {
    const input = `Open ${market.indexTokenSymbol.toLowerCase()}/usdt long with 10 USDT margin`
    const parsed = parseUserInput(input, markets)
    assert.equal(parsed.market, market.indexTokenSymbol)
    assert.deepEqual(validateInput(parsed), [])
    assert.equal(
      generateOrderConfig(parsed, markets, tokenMeta).market,
      market.marketToken,
    )
  }
})

test('close intent takes precedence over the word positions', () => {
  const parsed = parseUserInput('Close my BTC long positions', markets)
  assert.equal(parsed.action, 'close')
  assert.equal(parsed.market, 'BTC')
  assert.equal(parsed.isLong, true)
})

test('close config does not guess collateral token', () => {
  const parsed = parseUserInput('Close my BTC long position', markets)
  const config = generateOrderConfig(parsed, markets, tokenMeta)
  assert.equal(config.orderType, 4)
  assert.equal(config.initialCollateralToken, undefined)
})

test('limit orders include trigger and acceptable prices', () => {
  const parsed = parseUserInput(
    'Open BTC long limit at 60000 with 10 USDT margin',
    markets,
  )
  const config = generateOrderConfig(parsed, markets, tokenMeta)
  assert.equal(config.triggerPriceHuman, 60000)
  assert.equal(config.acceptablePriceHuman, 61800)
})

test('close limit and protective orders include side-aware acceptable prices', () => {
  const long = generateOrderConfig(
    parseUserInput('Set stop-loss for BTC long at 60000', markets),
    markets,
    tokenMeta,
  )
  const short = generateOrderConfig(
    parseUserInput('Set take-profit for ETH short at 4000', markets),
    markets,
    tokenMeta,
  )
  assert.equal(long.acceptablePriceHuman, 58200)
  assert.equal(short.acceptablePriceHuman, 4120)
})

test('ambiguous, multi-leg, and negative instructions fail closed', () => {
  assert.throws(
    () => parseUserInput('Open BTC long then ETH short', markets),
    /Multi-leg/,
  )
  assert.throws(
    () => parseUserInput('Open BTC and ETH long with 10 USDT', markets),
    /Ambiguous markets/,
  )
  assert.throws(
    () => parseUserInput('Open BTC long with -10 USDT', markets),
    /Negative/,
  )
  assert.throws(
    () => parseUserInput('Open BTC long if price reaches 60000 with 10 USDT', markets),
    /Conditional prose/,
  )
  assert.throws(
    () => parseUserInput('Open and close BTC long with 10 USDT', markets),
    /both open and close/,
  )
})

test('leverage and notional caps are enforced', () => {
  const leverage = parseUserInput(
    'Open BTC long with 10 USDT margin and 21x leverage',
    markets,
  )
  assert.match(validateInput(leverage).join(' '), /at most 20x/)

  const notional = parseUserInput(
    'Open BTC long with 6000 USDT margin and 20x leverage',
    markets,
  )
  assert.match(validateInput(notional).join(' '), /100000 USD/)
})

test('TWAP total duration is distributed across all parts', () => {
  const parsed = parseUserInput(
    'TWAP open NGNm long with 20 USDT margin in 4 parts over 30 minutes',
    markets,
  )
  assert.equal(parsed.intervalSeconds, 600)
  const base = generateOrderConfig(parsed, markets, tokenMeta)
  const configs = generateTwapConfigs(parsed, base, 1000)
  assert.deepEqual(
    configs.map((config) => config.validFromTime),
    ['1000', '1600', '2200', '2800'],
  )
  assert.equal(
    configs.reduce(
      (sum, config) =>
        sum.add(
          ethers.utils.parseUnits(
            config.initialCollateralDeltaAmountHuman,
            6,
          ),
        ),
      ethers.BigNumber.from(0),
    ).toString(),
    ethers.utils.parseUnits('20', 6).toString(),
  )
})

test('TWAP split preserves exact totals for indivisible amounts', () => {
  const parsed = parseUserInput(
    'TWAP open BTC long with 10 USDT margin in 3 parts over 10 minutes',
    markets,
  )
  const base = generateOrderConfig(parsed, markets, tokenMeta)
  const configs = generateTwapConfigs(parsed, base, 1000)
  const total = configs.reduce(
    (sum, config) =>
      sum.add(
        ethers.utils.parseUnits(
          config.initialCollateralDeltaAmountHuman,
          6,
        ),
      ),
    ethers.BigNumber.from(0),
  )
  assert.equal(total.toString(), ethers.utils.parseUnits('10', 6).toString())
})

test('order queries are recognized explicitly', () => {
  const parsed = parseUserInput('List my orders', markets)
  assert.equal(parsed.action, 'query')
  assert.equal(parsed.queryType, 'orders')
})
