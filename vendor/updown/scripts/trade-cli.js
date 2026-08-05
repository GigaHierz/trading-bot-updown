const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const addresses = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/addresses.json'), 'utf8'),
)
const markets = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
)
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/celo-tokens.json'), 'utf8'),
)

// Order Types based on updown Synthetics (verified)
const OrderType = {
  // Increase Position Orders
  MarketIncrease: 2, // market increase ✅
  LimitIncrease: 3, // limit increase ✅
  // Decrease Position Orders
  MarketDecrease: 4, // market decrease
  LimitDecrease: 5, // limit decrease ✅ (take profit)
  StopLossDecrease: 6, // stop-loss decrease ✅
  TakeProfitDecrease: 5, // take-profit decrease (same as limit decrease)
}

// TWAP Order Types (custom extension)
const TwapOrderType = {
  TwapMarketIncrease: 7,
  TwapMarketDecrease: 8,
}

function printMarkets() {
  console.log('\n=== Available Markets ===\n')
  markets.forEach((m, i) => {
    console.log(`${i + 1}. ${m.indexTokenSymbol}/USDT`)
    console.log(`   Market Token: ${m.marketToken}`)
    console.log(`   Index Token: ${m.indexTokenSymbol} (${m.indexToken})`)
    console.log(`   Long Collateral: ${m.longTokenSymbol} (${m.longToken})`)
    console.log(`   Short Collateral: ${m.shortTokenSymbol} (${m.shortToken})`)
    console.log('')
  })
}

function printOrderTypes() {
  console.log('\n=== Order Types ===\n')
  console.log('[Increase Position]')
  console.log('  0. MarketIncrease     - market open (execute immediately)')
  console.log('  1. LimitIncrease      - limit open (execute at trigger price)')
  console.log('  7. TwapMarketIncrease - TWAP split open (reduce slippage)')
  console.log('')
  console.log('[Decrease Position]')
  console.log('  4. MarketDecrease     - market close (execute immediately)')
  console.log('  5. LimitDecrease      - limit close (execute at trigger price)')
  console.log('  6. StopLossDecrease   - stop-loss close (triggered by price)')
  console.log('  5. TakeProfitDecrease - take-profit close (triggered by price)')
  console.log('  5. TwapMarketDecrease - TWAP split close (reduce slippage)')
  console.log('')
}

function printCreateOrderParams() {
  console.log('\n=== createOrder parameters ===\n')
  console.log('[Address fields (addresses)]')
  console.log('  - receiver:                receiver address (default: wallet)')
  console.log('  - cancellationReceiver:    cancellation receiver (default: wallet)')
  console.log('  - uiFeeReceiver:           UI fee receiver (default: 0x0)')
  console.log('  - callbackContract:        callback contract (default: 0x0)')
  console.log('  - market:                  market address (required)')
  console.log('  - initialCollateralToken:  initial collateral token (required)')
  console.log('  - swapPath:                swap path (default: [])')
  console.log('')
  console.log('[Numeric fields (numbers)]')
  console.log('  - sizeDeltaUsd:               position size change (USD, 30 decimals)')
  console.log('  - initialCollateralDeltaAmount: initial collateral amount')
  console.log(
    '  - triggerPrice:               trigger price (for limit/stop orders, default: 0)',
  )
  console.log('  - acceptablePrice:            acceptable price (slippage protection)')
  console.log(
    '  - executionFee:               execution fee (CELO; estimated from on-chain gas config)',
  )
  console.log('  - callbackGasLimit:           callback gas limit (default: 0)')
  console.log('  - minOutputAmount:            minimum output amount (default: 0)')
  console.log('  - validFromTime:              valid-from timestamp (default: 0)')
  console.log('')
  console.log('[Other fields]')
  console.log('  - orderType:                  order type (0-8, required)')
  console.log('  - decreasePositionSwapType:   decrease swap type (default: 0)')
  console.log('  - isLong:                     long or short (true/false, required)')
  console.log('  - shouldUnwrapNativeToken:    unwrap native token (default: false)')
  console.log(
    '  - autoCancel:                 auto cancel (default: true if omitted in open / close / TWAP scripts)',
  )
  console.log('  - referralCode:               referral code (default: 0x0)')
  console.log('')
}

function generateOrderTemplate(orderTypeName) {
  const templates = {
    MarketIncrease: {
      name: 'Market Increase',
      description: 'Open position immediately at current market price',
      template: {
        market: '0xDbBe49A7165F40C79D00bCD3B456AaE887c3d771',
        indexToken: '0x57433eD8eC1FAD60b8E1dcFdD1fBD56aBA19C04C',
        initialCollateralToken: '0xd96a1ac57a180a3819633bCE3dC602Bd8972f595',
        isLong: true,
        orderType: 2,
        sizeDeltaUsdHuman: 10,
        initialCollateralDeltaAmountHuman: 10,
        swapPath: [],
      },
    },
    LimitIncrease: {
      name: 'Limit Increase',
      description: 'Open position when price reaches specified trigger',
      template: {
        market: '0xDbBe49A7165F40C79D00bCD3B456AaE887c3d771',
        indexToken: '0x57433eD8eC1FAD60b8E1dcFdD1fBD56aBA19C04C',
        initialCollateralToken: '0xd96a1ac57a180a3819633bCE3dC602Bd8972f595',
        isLong: true,
        orderType: 3,
        sizeDeltaUsdHuman: 10,
        initialCollateralDeltaAmountHuman: 10,
        triggerPriceHuman: 70000,
        acceptablePriceHuman: 70500,
        swapPath: [],
      },
    },
    StopLossDecrease: {
      name: 'Stop Loss',
      description: 'Automatically close when stop-loss price is hit',
      template: {
        market: '0xDbBe49A7165F40C79D00bCD3B456AaE887c3d771',
        indexToken: '0x57433eD8eC1FAD60b8E1dcFdD1fBD56aBA19C04C',
        isLong: true,
        orderType: 6,
        closePercent: 100,
        triggerPriceHuman: 65000,
        acceptablePriceHuman: 64500,
      },
    },
    TakeProfitDecrease: {
      name: 'Take Profit',
      description: 'Automatically close when take-profit price is hit',
      template: {
        market: '0xDbBe49A7165F40C79D00bCD3B456AaE887c3d771',
        indexToken: '0x57433eD8eC1FAD60b8E1dcFdD1fBD56aBA19C04C',
        isLong: true,
        orderType: 5,
        closePercent: 100,
        triggerPriceHuman: 80000,
        acceptablePriceHuman: 79500,
      },
    },
    TwapMarketIncrease: {
      name: 'TWAP Split Increase',
      description:
        'Split a large order into multiple smaller ones; multicall with a single tx hash',
      // No hand-editable template: every part of a TWAP must carry the shared
      // uiFeeReceiver that encodes part count and group id. A config written by
      // hand omits it, and the resulting orders are created as unrelated limit
      // orders that the protocol later cancels.
      generatorOnly: true,
    },
  }

  if (orderTypeName && templates[orderTypeName]) {
    const t = templates[orderTypeName]
    console.log(`\n=== ${t.name} ===`)
    console.log(`Description: ${t.description}\n`)
    if (t.generatorOnly) {
      console.log('TWAP orders cannot be written by hand.')
      console.log(
        'Each part must share a uiFeeReceiver that encodes the part count and',
      )
      console.log(
        'group id; without it the parts are created as unrelated limit orders',
      )
      console.log('and are cancelled by the protocol.\n')
      console.log('Generate the parts, then send them:')
      console.log(
        '  node scripts/trade-assistant.js "twap open ETH/USDT long 3x with 6 USDT collateral in 2 parts every 15 seconds"',
      )
      console.log('  node scripts/send-twap-multicall.js "<pattern>"\n')
      return null
    }
    console.log('Template config:')
    console.log(JSON.stringify(t.template, null, 2))
    return t.template
  } else {
    console.log('\n=== Available order templates ===\n')
    Object.entries(templates).forEach(([key, t]) => {
      console.log(`${key}:`)
      console.log(`  ${t.description}`)
      if (t.generatorOnly) {
        console.log('  ⚠️  generator only — use scripts/trade-assistant.js')
      }
    })
    return null
  }
}

async function main() {
  const command = process.argv[2]

  switch (command) {
    case 'markets':
      printMarkets()
      break
    case 'order-types':
      printOrderTypes()
      break
    case 'params':
      printCreateOrderParams()
      break
    case 'template':
      generateOrderTemplate(process.argv[3])
      break
    default:
      console.log('\n=== UPDOWN Trade CLI ===\n')
      console.log('Usage: node trade-cli.js <command>\n')
      console.log('Available commands:')
      console.log('  markets              - list available markets')
      console.log('  order-types          - list order types')
      console.log('  params               - show createOrder parameter list')
      console.log(
        '  template [type]      - generate order template (e.g. MarketIncrease, LimitIncrease)',
      )
      console.log('')
      console.log('Examples:')
      console.log('  node trade-cli.js markets')
      console.log('  node trade-cli.js template MarketIncrease')
      console.log('')
  }
}

main().catch(console.error)
