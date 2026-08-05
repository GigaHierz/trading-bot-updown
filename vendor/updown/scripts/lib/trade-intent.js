const { ethers } = require('ethers')
const { findMarket, findTokenEntry } = require('./protocol')

const MAX_UINT256 = ethers.constants.MaxUint256.toString()
const DEFAULT_MAX_LEVERAGE = 100
const DEFAULT_MAX_NOTIONAL_USD = 100000

function canonicalSymbol(markets, value) {
  const market = findMarket(markets, value)
  return market ? market.indexTokenSymbol : null
}

function unique(values) {
  return [...new Set(values)]
}

function collectMarkets(input, markets) {
  return unique(
    markets
      .filter((market) =>
        new RegExp(`\\b${market.indexTokenSymbol}\\b`, 'i').test(input),
      )
      .map((market) => market.indexTokenSymbol),
  )
}

function parseDuration(input, parts) {
  const total = input.match(
    /(?:over|within|during)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  )
  const every = input.match(
    /(?:every|interval)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  )

  const seconds = (match) => {
    if (!match) return null
    const value = Number(match[1])
    const unit = match[2].toLowerCase()
    if (unit.startsWith('hour') || unit.startsWith('hr')) return value * 3600
    if (unit.startsWith('min')) return value * 60
    return value
  }

  if (total) {
    const totalSeconds = seconds(total)
    return {
      totalDurationSeconds: totalSeconds,
      intervalSeconds:
        parts > 1 ? Math.max(1, Math.floor(totalSeconds / (parts - 1))) : 0,
    }
  }
  if (every) return { intervalSeconds: Math.floor(seconds(every)) }
  return { intervalSeconds: 300 }
}

function parseUserInput(input, markets) {
  const text = String(input || '').trim()
  if (!text) throw new Error('Trading instruction is empty')
  if (/(^|[^\w.])-\d+(?:\.\d+)?/.test(text)) {
    throw new Error('Negative amounts are not allowed')
  }
  if (/(?:\bthen\b|\bafter that\b|;|\n)/i.test(text)) {
    throw new Error('Multi-leg instructions are not supported; submit one action at a time')
  }
  if (
    /\b(?:if|when|unless|once|reaches?|crosses?)\b/i.test(text)
  ) {
    throw new Error(
      'Conditional prose is not supported; use an explicit limit, stop-market, stop-loss, or take-profit price',
    )
  }
  if (/\b(?:open|create)\b/i.test(text) && /\bclose\b/i.test(text)) {
    throw new Error('Ambiguous action: both open and close were found')
  }

  const lower = text.toLowerCase()
  const hasStopLoss = /stop[- ]loss/.test(lower)
  const hasTakeProfit = /take[- ]profit/.test(lower)
  if (hasStopLoss && hasTakeProfit) {
    throw new Error('Submit stop-loss and take-profit as separate instructions')
  }

  const marketsFound = collectMarkets(text, markets)
  if (marketsFound.length > 1) {
    throw new Error(`Ambiguous markets: ${marketsFound.join(', ')}`)
  }

  const directions = unique(
    [
      /\b(?:long|buy)\b/i.test(text) ? 'long' : null,
      /\b(?:short|sell)\b/i.test(text) ? 'short' : null,
    ].filter(Boolean),
  )
  if (directions.length > 1) {
    throw new Error('Ambiguous direction: both long/buy and short/sell were found')
  }

  const actionWord = /\b(?:open|create|close|set|buy|sell|long|short)\b/i.test(
    text,
  )
  const queryWord = /\b(?:query|show|list|check|view)\b/i.test(text)
  let action
  let queryType
  if (!actionWord && queryWord) {
    action = 'query'
    queryType = /\borders?\b/i.test(text)
      ? 'orders'
      : /\bbalances?\b/i.test(text)
      ? 'balance'
      : 'positions'
  } else if (hasStopLoss) {
    action = 'stopLoss'
  } else if (hasTakeProfit) {
    action = 'takeProfit'
  } else if (/\bclose\b/i.test(text)) {
    action = 'close'
  } else if (
    /\b(?:open|create|buy|sell|long|short|market|limit|twap)\b/i.test(text)
  ) {
    action = 'open'
  } else {
    throw new Error('Unrecognized instruction; specify query, open, close, stop-loss, or take-profit')
  }

  let orderType = null
  if (/\btwap\b/i.test(text)) orderType = 'twap'
  else if (hasStopLoss) orderType = 'stopLoss'
  else if (hasTakeProfit) orderType = 'takeProfit'
  else if (/stop[- ]market/i.test(text)) orderType = 'stopMarket'
  else if (/\blimit\b/i.test(text)) orderType = 'limit'
  else if (action !== 'query') orderType = 'market'

  const result = {
    action,
    queryType,
    market: marketsFound[0] || null,
    orderType,
    isLong:
      directions[0] === 'long'
        ? true
        : directions[0] === 'short'
        ? false
        : null,
    leverage: 1,
    closePercent: 100,
  }

  const percent = text.match(/(\d+(?:\.\d+)?)\s*%/)
  if (percent) result.closePercent = Number(percent[1])

  const leverage = text.match(/(\d+(?:\.\d+)?)\s*x\b/i)
  if (leverage) result.leverage = Number(leverage[1])

  const trigger =
    text.match(
      /(?:trigger|limit(?:\s+price)?|price)\s*(?:[:=@]|\bat\b)?\s*(\d+(?:\.\d+)?)/i,
    ) || text.match(/\bat\s+(\d+(?:\.\d+)?)/i)
  if (trigger) result.triggerPrice = Number(trigger[1])

  const parts = text.match(/(\d+)\s*(?:parts?|orders?|slices?)/i)
  if (orderType === 'twap') {
    result.twapParts = parts ? Number(parts[1]) : 2
    Object.assign(result, parseDuration(text, result.twapParts))
  }

  const value = text.match(
    /(\d+(?:\.\d+)?)\s*(?:USDT|USD|U)\s*(?:worth\s+of)\s*([A-Za-z]+)/i,
  )
  const amount = text.match(
    /(\d+(?:\.\d+)?)\s*(USDT|USD|U|BTC|ETH|CELO|EURm|JPYm|NGNm|AUDm|GBPm)\b/i,
  )
  if (value) {
    result.collateralValueUsd = Number(value[1])
    result.collateralTokenSymbol =
      canonicalSymbol(markets, value[2]) || value[2].toUpperCase()
    result.paymentTokenSymbol = result.collateralTokenSymbol
  } else if (amount) {
    const symbol = /^(?:USD|U)$/i.test(amount[2]) ? 'USDT' : amount[2]
    result.collateralUsd = Number(amount[1])
    result.paymentTokenSymbol =
      canonicalSymbol(markets, symbol) || symbol.toUpperCase()
  }

  const collateral = text.match(
    /(USDT|BTC|ETH|CELO|EURm|JPYm|NGNm|AUDm|GBPm)\s*(?:collateral|margin)/i,
  )
  if (collateral) {
    result.collateralTokenSymbol =
      canonicalSymbol(markets, collateral[1]) || collateral[1].toUpperCase()
  }

  return result
}

function validateInput(parsed) {
  const errors = []
  if (parsed.action === 'query') return errors
  if (!parsed.market) errors.push('Specify exactly one market')
  if (parsed.isLong === null) errors.push('Specify long or short')
  if (parsed.closePercent <= 0 || parsed.closePercent > 100) {
    errors.push('closePercent must be greater than 0 and at most 100')
  }

  if (parsed.action === 'open') {
    if (!parsed.collateralUsd && !parsed.collateralValueUsd) {
      errors.push('Specify a positive margin amount')
    }
    if (parsed.collateralValueUsd) {
      errors.push(
        '“USD worth of token” requires a live conversion; specify the token amount directly',
      )
    }
    if (
      parsed.paymentTokenSymbol &&
      parsed.paymentTokenSymbol.toLowerCase() !== 'usdt'
    ) {
      errors.push(
        'Natural-language sizing currently accepts USDT margin only; use a structured config for other collateral tokens',
      )
    }
    const maxLeverage = Number(
      process.env.UPDOWN_MAX_LEVERAGE || DEFAULT_MAX_LEVERAGE,
    )
    if (
      !Number.isFinite(parsed.leverage) ||
      parsed.leverage <= 0 ||
      parsed.leverage > maxLeverage
    ) {
      errors.push(`Leverage must be greater than 0 and at most ${maxLeverage}x`)
    }
    const notional =
      (parsed.collateralUsd || parsed.collateralValueUsd || 0) * parsed.leverage
    const maxNotional = Number(
      process.env.UPDOWN_MAX_NOTIONAL_USD || DEFAULT_MAX_NOTIONAL_USD,
    )
    if (notional > maxNotional) {
      errors.push(`Position notional must not exceed ${maxNotional} USD`)
    }
  }

  if (
    ['limit', 'stopMarket', 'stopLoss', 'takeProfit'].includes(parsed.orderType) &&
    !parsed.triggerPrice
  ) {
    errors.push('Specify a positive trigger price')
  }
  if (parsed.triggerPrice !== undefined && parsed.triggerPrice <= 0) {
    errors.push('Trigger price must be positive')
  }
  if (parsed.orderType === 'twap') {
    if (!Number.isInteger(parsed.twapParts) || parsed.twapParts < 2 || parsed.twapParts > 20) {
      errors.push('TWAP parts must be an integer from 2 to 20')
    }
    if (!Number.isInteger(parsed.intervalSeconds) || parsed.intervalSeconds < 1) {
      errors.push('TWAP interval must be at least one second')
    }
  }
  return errors
}

function slippagePrice(triggerPrice, multiplier) {
  return Number((triggerPrice * multiplier).toPrecision(15))
}

function tokenAddress(tokenMeta, symbol) {
  const entry = findTokenEntry(tokenMeta, symbol)
  if (!entry) throw new Error(`Unsupported token: ${symbol}`)
  return entry[1].address
}

function generateOrderConfig(parsed, markets, tokenMeta) {
  const errors = validateInput(parsed)
  if (errors.length) throw new Error(errors.join('; '))

  const marketInfo = findMarket(markets, parsed.market)
  if (!marketInfo) throw new Error(`Market not found: ${parsed.market}`)

  const config = {
    market: marketInfo.marketToken,
    marketSymbol: `${marketInfo.indexTokenSymbol}/${marketInfo.shortTokenSymbol}`,
    indexToken: marketInfo.indexToken,
    isLong: parsed.isLong,
  }

  if (parsed.action === 'open') {
    const paymentSymbol = parsed.paymentTokenSymbol || 'USDT'
    const collateralSymbol =
      parsed.collateralTokenSymbol || paymentSymbol || 'USDT'
    config.initialCollateralToken = tokenAddress(tokenMeta, paymentSymbol)
    config.swapPath = []

    if (paymentSymbol.toLowerCase() !== collateralSymbol.toLowerCase()) {
      const swapMarket = markets.find((market) => {
        const index = market.indexTokenSymbol.toLowerCase()
        const short = market.shortTokenSymbol.toLowerCase()
        const payment = paymentSymbol.toLowerCase()
        const collateral = collateralSymbol.toLowerCase()
        return (
          (index === payment && short === collateral) ||
          (index === collateral && short === payment)
        )
      })
      if (!swapMarket) {
        throw new Error(
          `No configured swap path from ${paymentSymbol} to ${collateralSymbol}`,
        )
      }
      config.swapPath = [swapMarket.marketToken]
    }

    config.orderType =
      parsed.orderType === 'limit'
        ? 3
        : parsed.orderType === 'stopMarket'
        ? 8
        : parsed.orderType === 'twap'
        ? 3
        : 2
    config.sizeDeltaUsdHuman =
      (parsed.collateralValueUsd || parsed.collateralUsd) * parsed.leverage
    config.initialCollateralDeltaAmountHuman =
      parsed.collateralValueUsd || parsed.collateralUsd

    if (parsed.triggerPrice) {
      config.triggerPriceHuman = parsed.triggerPrice
      if (parsed.orderType === 'limit') {
        config.acceptablePriceHuman = slippagePrice(
          parsed.triggerPrice,
          parsed.isLong ? 1.03 : 0.97,
        )
      }
    }
  } else {
    config.orderType =
      parsed.action === 'stopLoss'
        ? 6
        : parsed.action === 'takeProfit' || parsed.orderType === 'limit'
        ? 5
        : parsed.orderType === 'twap'
        ? 5
        : 4
    config.closePercent = parsed.closePercent
    if (parsed.collateralTokenSymbol) {
      config.initialCollateralToken = tokenAddress(
        tokenMeta,
        parsed.collateralTokenSymbol,
      )
    }
    if (parsed.triggerPrice) {
      config.triggerPriceHuman = parsed.triggerPrice
      config.acceptablePriceHuman = slippagePrice(
        parsed.triggerPrice,
        parsed.isLong ? 0.97 : 1.03,
      )
    }
  }

  return config
}

function generateTwapConfigs(parsed, baseConfig, now = Math.floor(Date.now() / 1000)) {
  const configs = []
  const parts = parsed.twapParts
  const uiFeeReceiver = createTwapUiFeeReceiver(parts)
  const sizeParts =
    parsed.action === 'open'
      ? splitHumanAmount(baseConfig.sizeDeltaUsdHuman, parts, 30)
      : null
  const collateralParts =
    parsed.action === 'open'
      ? splitHumanAmount(
          baseConfig.initialCollateralDeltaAmountHuman,
          parts,
          6,
        )
      : null

  for (let index = 0; index < parts; index += 1) {
    const config = {
      ...baseConfig,
      validFromTime: String(now + parsed.intervalSeconds * index),
      uiFeeReceiver,
    }
    if (parsed.action === 'open') {
      config.sizeDeltaUsdHuman = sizeParts[index]
      config.initialCollateralDeltaAmountHuman = collateralParts[index]
      config.orderType = 3
      config.acceptablePrice = parsed.isLong ? MAX_UINT256 : '0'
      config.triggerPrice = parsed.isLong ? MAX_UINT256 : '0'
    } else {
      const basePercent = Math.floor(10000 / parts) / 100
      config.closePercent =
        index === parts - 1
          ? Number((100 - basePercent * (parts - 1)).toFixed(2))
          : basePercent
      config.orderType = 5
      config.acceptablePrice = parsed.isLong ? '0' : MAX_UINT256
      config.triggerPrice = parsed.isLong ? '0' : MAX_UINT256
    }
    configs.push(config)
  }
  return configs
}

function splitHumanAmount(total, parts, decimals) {
  const totalRaw = ethers.utils.parseUnits(String(total), decimals)
  const divisor = ethers.BigNumber.from(parts)
  const base = totalRaw.div(divisor)
  const remainder = totalRaw.sub(base.mul(divisor))
  return Array.from({ length: parts }, (_, index) =>
    ethers.utils.formatUnits(
      index === parts - 1 ? base.add(remainder) : base,
      decimals,
    ),
  )
}

function createTwapUiFeeReceiver(parts) {
  const id = Math.floor(Math.random() * 65536)
    .toString(16)
    .padStart(4, '0')
  return `0xff0000${'00'.repeat(12)}00${Number(parts)
    .toString(16)
    .padStart(2, '0')}${id}01`
}

module.exports = {
  generateOrderConfig,
  generateTwapConfigs,
  parseUserInput,
  splitHumanAmount,
  validateInput,
}
