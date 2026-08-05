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
const exchangeRouterAbi = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../assets/abis/ExchangeRouter.json'),
    'utf8',
  ),
).abi
const readerAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/Reader.json'), 'utf8'),
).abi

const chainlinkPriceFeedProviderAbi = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../assets/abis/ChainlinkPriceFeedProvider.json'),
    'utf8',
  ),
).abi
const dataStoreAbi = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../assets/abis/DataStore.json'),
    'utf8',
  ),
).abi
const errorsAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/Errors.json'), 'utf8'),
).abi
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/celo-tokens.json'), 'utf8'),
)
const markets = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
)
const { reportTrade } = require('./lib/report-trade')
const { resolveExecutionFee } = require('./lib/protocol')

function decodeRevertReason(error) {
  const data =
    error?.error?.data ||
    error?.data ||
    error?.error?.error?.data ||
    error?.receipt?.revertReason
  if (!data || typeof data !== 'string') return 'Unknown revert reason'
  try {
    const iface = new ethers.utils.Interface(errorsAbi)
    const parsed = iface.parseError(data)
    return `${parsed.name}(${parsed.args.map((x) => x.toString()).join(', ')})`
  } catch {}
  if (data.startsWith('0x08c379a0')) {
    try {
      return ethers.utils.defaultAbiCoder.decode(
        ['string'],
        '0x' + data.slice(10),
      )[0]
    } catch {
      return 'Reverted (string decode failed)'
    }
  }
  return 'Reverted (no string reason)'
}

function readConfig(configPath) {
  const fullPath = path.resolve(process.cwd(), configPath)
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'))
}

function toUnits(value, decimals) {
  if (value === undefined || value === null) return undefined
  return ethers.utils.parseUnits(String(value), decimals).toString()
}

function normalizeAddr(addr) {
  return (addr || '').toLowerCase()
}

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function keyOfString(value) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['string'], [value]),
  )
}

function findTokenDecimalsByAddress(tokenAddress) {
  const target = normalizeAddr(tokenAddress)
  for (const meta of Object.values(tokenMeta)) {
    if (normalizeAddr(meta.address) === target) return meta.decimals
  }
  return null
}

function findMarketInfo(marketToken) {
  const target = normalizeAddr(marketToken)
  return markets.find((m) => normalizeAddr(m.marketToken) === target) || null
}

function parseClosePercent(value) {
  if (value === undefined || value === null || String(value).trim() === '')
    return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid closePercent: ${value}`)
  }
  if (parsed < 1 || parsed > 100) {
    throw new Error(`closePercent out of range [1,100]: ${parsed}`)
  }
  return parsed
}

async function main() {
  const configPath = process.argv[2]
  if (!configPath) throw new Error('Missing config file path')

  const cfg = readConfig(configPath)
  const rpcUrl = process.env.CELO_RPC_URL
  const privateKey = process.env.CELO_PRIVATE_KEY
  if (!rpcUrl || !privateKey) {
    throw new Error(
      'Missing CELO_RPC_URL or CELO_PRIVATE_KEY in assets/celo.env.local',
    )
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || '42220'),
    name: 'celo',
  })
  const wallet = new ethers.Wallet(privateKey, provider)

  const exchangeRouter = new ethers.Contract(
    addresses.celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet,
  )
  const reader = new ethers.Contract(addresses.celo.Reader, readerAbi, provider)
  const dataStore = new ethers.Contract(
    addresses.celo.DataStore,
    dataStoreAbi,
    provider,
  )
  const chainlinkPriceFeedProviderAddress =
    cfg.chainlinkPriceFeedProvider || addresses.celo.ChainlinkPriceFeedProvider
  const chainlinkPriceFeedProvider = chainlinkPriceFeedProviderAddress
    ? new ethers.Contract(
        chainlinkPriceFeedProviderAddress,
        chainlinkPriceFeedProviderAbi,
        provider,
      )
    : null

  const account = cfg.account || wallet.address
  const orderVault = cfg.orderVault || addresses.celo.OrderVault
  const isLong = isTrue(cfg.isLong)
  if (!orderVault) throw new Error('Missing OrderVault address')

  console.log('wallet:', account)

  const start = Number(cfg.positionStart ?? 0)
  const end = Number(cfg.positionEnd ?? 50)
  const allPositions = await reader.getAccountPositions(
    addresses.celo.DataStore,
    account,
    start,
    end,
  )
  const openPositions = allPositions.filter((p) =>
    ethers.BigNumber.from(p.numbers.sizeInUsd || 0).gt(0),
  )

  console.log(
    `positions fetched: ${allPositions.length}, open: ${openPositions.length}`,
  )
  for (const p of openPositions) {
    const m = findMarketInfo(p.addresses.market)
    const label = m
      ? `${m.indexTokenSymbol}-${m.shortTokenSymbol}`
      : p.addresses.market
    console.log(
      `- market: ${label}, isLong: ${
        p.flags.isLong
      }, sizeUsd: ${ethers.utils.formatUnits(
        p.numbers.sizeInUsd,
        30,
      )}, collateral: ${p.addresses.collateralToken}`,
    )
  }

  let candidates = openPositions.filter((p) => p.flags.isLong === isLong)
  if (cfg.market) {
    candidates = candidates.filter(
      (p) => normalizeAddr(p.addresses.market) === normalizeAddr(cfg.market),
    )
  }
  if (cfg.initialCollateralToken) {
    candidates = candidates.filter(
      (p) =>
        normalizeAddr(p.addresses.collateralToken) ===
        normalizeAddr(cfg.initialCollateralToken),
    )
  }
  if (cfg.indexToken) {
    candidates = candidates.filter((p) => {
      const m = findMarketInfo(p.addresses.market)
      return m && normalizeAddr(m.indexToken) === normalizeAddr(cfg.indexToken)
    })
  }

  if (candidates.length === 0) {
    // Special-case check: CELO/USDT long with USDT collateral
    const isCeloUsdtMarket =
      cfg.market &&
      normalizeAddr(cfg.market) ===
        normalizeAddr('0x1f39c2B41af79973b25F65E7a4234bc22aF250D7')
    const isUsdtCollateral =
      cfg.initialCollateralToken &&
      normalizeAddr(cfg.initialCollateralToken) ===
        normalizeAddr('0xd96a1ac57a180a3819633bCE3dC602Bd8972f595')

    if (isCeloUsdtMarket && isLong && isUsdtCollateral) {
      console.log('\n❌ Error: no matching position found')
      console.log('   Condition: CELO/USDT market + long + USDT collateral')
      console.log(
        '   There is no matching open position; cannot close / take profit / stop loss.',
      )
      console.log('   Please create a position first or check config.\n')
    }

    throw new Error(
      'No matching open position found. Provide market/isLong/initialCollateralToken/indexToken to disambiguate.',
    )
  }
  if (candidates.length > 1) {
    throw new Error(
      'Multiple positions match market and side. Set initialCollateralToken to select one explicitly.',
    )
  }

  candidates.sort((a, b) => {
    const sa = ethers.BigNumber.from(a.numbers.sizeInUsd)
    const sb = ethers.BigNumber.from(b.numbers.sizeInUsd)
    if (sb.gt(sa)) return 1
    if (sb.lt(sa)) return -1
    return 0
  })
  const target = candidates[0]
  const marketInfo = findMarketInfo(target.addresses.market)
  const indexToken = cfg.indexToken || marketInfo?.indexToken
  if (!indexToken) {
    throw new Error(
      'Unable to resolve indexToken from position market; set cfg.indexToken',
    )
  }

  const positionSizeUsd = ethers.BigNumber.from(target.numbers.sizeInUsd)
  const closePercent = parseClosePercent(cfg.closePercent)
  let sizeDeltaUsd
  if (closePercent !== null) {
    // Use integer math to avoid precision loss with JS floats.
    sizeDeltaUsd = positionSizeUsd
      .mul(Math.round(closePercent * 10000))
      .div(100 * 10000)
    if (sizeDeltaUsd.lte(0)) {
      throw new Error('closePercent results in zero sizeDeltaUsd')
    }
    console.log(
      'closePercent:',
      closePercent,
      '=> closeSizeUsd:',
      ethers.utils.formatUnits(sizeDeltaUsd, 30),
    )
  } else {
    const requestedSizeUsd =
      cfg.sizeDeltaUsd ??
      toUnits(cfg.sizeDeltaUsdHuman, 30) ??
      positionSizeUsd.toString()
    sizeDeltaUsd = ethers.BigNumber.from(requestedSizeUsd)
  }

  if (sizeDeltaUsd.gt(positionSizeUsd)) {
    throw new Error(
      `sizeDeltaUsd exceeds position size: ${sizeDeltaUsd.toString()} > ${positionSizeUsd.toString()}`,
    )
  }

  const indexTokenDecimals = findTokenDecimalsByAddress(indexToken) ?? 8
  const acceptablePriceDecimals = 30 - Number(indexTokenDecimals)
  console.log('indexTokenDecimals:', indexTokenDecimals)
  console.log('acceptablePriceDecimals:', acceptablePriceDecimals)
  if (acceptablePriceDecimals < 0) {
    throw new Error(
      'Invalid index token decimals for acceptablePrice conversion',
    )
  }

  const executionFee = await resolveExecutionFee({
    cfg,
    dataStore,
    provider,
    gasLimitKey: 'DECREASE_ORDER_GAS_LIMIT',
    swapCount: (cfg.swapPath || []).length,
    oraclePriceCount: 3 + (cfg.swapPath || []).length,
    callbackGasLimit: cfg.callbackGasLimit || 0,
  })
  if (!executionFee) throw new Error('Missing executionFee / executionFeeHuman')

  const hasAcceptablePriceFromConfig =
    cfg.acceptablePrice !== undefined ||
    (cfg.acceptablePriceHuman !== undefined &&
      cfg.acceptablePriceHuman !== null &&
      String(cfg.acceptablePriceHuman).trim() !== '')

  async function getReferenceOraclePrice() {
    if (!chainlinkPriceFeedProvider) {
      throw new Error('ChainlinkPriceFeedProvider not available')
    }
    const price = await chainlinkPriceFeedProvider.getOraclePrice(
      indexToken,
      '0x',
    )
    return {
      source: `ChainlinkPriceFeedProvider ${chainlinkPriceFeedProviderAddress}`,
      price,
    }
  }

  // Handle triggerPrice: support triggerPriceHuman (with acceptablePriceDecimals precision)
  const triggerPrice =
    cfg.triggerPrice ??
    (cfg.triggerPriceHuman !== undefined &&
    cfg.triggerPriceHuman !== null &&
    String(cfg.triggerPriceHuman).trim() !== ''
      ? toUnits(cfg.triggerPriceHuman, acceptablePriceDecimals)
      : '0')
  console.log(
    'triggerPrice:',
    triggerPrice,
    cfg.triggerPriceHuman !== undefined
      ? `(from ${cfg.triggerPriceHuman} with ${acceptablePriceDecimals} decimals)`
      : '',
  )

  let acceptablePrice =
    cfg.acceptablePrice ??
    toUnits(cfg.acceptablePriceHuman, acceptablePriceDecimals)
  if (!hasAcceptablePriceFromConfig) {
    const { source, price } = await getReferenceOraclePrice()
    const mid = price.min.add(price.max).div(2)
    const adjusted = isLong ? mid.mul(97).div(100) : mid.mul(103).div(100)
    acceptablePrice = adjusted.toString()
    console.log(`oracle provider: ${source}`)
    console.log(
      `acceptablePriceHuman auto-set for close (${
        isLong ? 'long -3%' : 'short +3%'
      }):`,
      ethers.utils.formatUnits(adjusted, acceptablePriceDecimals),
    )
  }

  console.log(
    'selected position:',
    target.addresses.market,
    'isLong:',
    target.flags.isLong,
    'sizeUsd:',
    ethers.utils.formatUnits(positionSizeUsd, 30),
    'closeSizeUsd:',
    ethers.utils.formatUnits(sizeDeltaUsd, 30),
  )

  try {
    const minPositionSizeUsd = await dataStore.getUint(
      keyOfString('MIN_POSITION_SIZE_USD'),
    )
    console.log(
      'minPositionSizeUsd:',
      ethers.utils.formatUnits(minPositionSizeUsd, 30),
    )
  } catch (err) {
    console.log('limit checks failed:', decodeRevertReason(err))
  }

  const params = {
    addresses: {
      receiver: cfg.receiver || account,
      cancellationReceiver: cfg.cancellationReceiver || account,
      callbackContract: cfg.callbackContract || ethers.constants.AddressZero,
      uiFeeReceiver: cfg.uiFeeReceiver || ethers.constants.AddressZero,
      market: target.addresses.market,
      initialCollateralToken: target.addresses.collateralToken,
      swapPath: cfg.swapPath || [],
    },
    numbers: {
      sizeDeltaUsd: sizeDeltaUsd.toString(),
      initialCollateralDeltaAmount: cfg.initialCollateralDeltaAmount || '0',
      triggerPrice: triggerPrice,
      acceptablePrice,
      executionFee,
      callbackGasLimit: cfg.callbackGasLimit || '0',
      minOutputAmount: cfg.minOutputAmount || '0',
      validFromTime: cfg.validFromTime || '0',
    },
    // Default to MarketDecrease (4), but prefer cfg.orderType from config file
    orderType: cfg.orderType ?? 4,
    decreasePositionSwapType: 0,
    isLong,
    shouldUnwrapNativeToken: Boolean(cfg.shouldUnwrapNativeToken),
    autoCancel: Boolean(cfg.autoCancel ?? true),
    referralCode: cfg.referralCode || ethers.constants.HashZero,
  }

  const multicallArgs = [
    exchangeRouter.interface.encodeFunctionData('sendWnt', [
      orderVault,
      executionFee,
    ]),
    exchangeRouter.interface.encodeFunctionData('createOrder', [params]),
  ]

  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: executionFee,
    })
    const tx = await exchangeRouter.multicall(multicallArgs, {
      value: executionFee,
    })
    console.log('\n=== Transaction submitted ===')
    console.log('createOrder txHash:', tx.hash)
    console.log('Explorer:', `https://celoscan.io/tx/${tx.hash}`)

    const receipt = await tx.wait()
    console.log('\n=== Transaction confirmed ===')
    console.log('status:', receipt.status === 1 ? '✅ Success' : '❌ Failed')
    console.log('blockNumber:', receipt.blockNumber)
    console.log('gasUsed:', receipt.gasUsed.toString())

    // Parse OrderCreated event
    let orderKey = null
    let eventOrderType = null
    let eventAccount = null
    const orderCreatedEvent = receipt.logs.find((log) => {
      try {
        const parsed = exchangeRouter.interface.parseLog(log)
        return parsed.name === 'OrderCreated'
      } catch {
        return false
      }
    })

    if (orderCreatedEvent) {
      const parsedEvent = exchangeRouter.interface.parseLog(orderCreatedEvent)
      orderKey = parsedEvent.args.key ? String(parsedEvent.args.key) : null
      eventOrderType = parsedEvent.args.orderType
        ? parsedEvent.args.orderType.toString()
        : null
      eventAccount = parsedEvent.args.account || null
      console.log('\n=== OrderCreated event ===')
      console.log('orderKey:', orderKey)
      console.log('orderType:', eventOrderType)
      console.log('account:', eventAccount)
    }

    console.log(
      '\nNote: close order has been created and is waiting for keeper execution...',
    )
    console.log('After execution completes, the position will be closed')

    if (receipt.status === 1) {
      const marketInfo = findMarketInfo(params.addresses.market)
      const orderTypeNum = Number(params.orderType)
      const isStopLoss = orderTypeNum === 6
      const isTakeProfit = orderTypeNum === 5
      const sizeDeltaUsdHuman =
        cfg.sizeDeltaUsdHuman != null
          ? String(cfg.sizeDeltaUsdHuman)
          : closePercent != null
            ? null
            : null
      const bothSlTp =
        Boolean(cfg.setSlTp) ||
        (cfg.stopLossOrderKey && cfg.takeProfitOrderKey) ||
        (cfg.hasStopLoss && cfg.hasTakeProfit)

      const positionKey =
        cfg.positionKey ||
        (target && (target.key || target.positionKey)) ||
        null
      const slTpGroupId =
        cfg.slTpGroupId ||
        (bothSlTp && tx.hash ? `sltp-${tx.hash}` : null)

      await reportTrade({
        action: bothSlTp ? 'set_sl_tp' : 'close_position',
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        account,
        orderKey,
        positionKey,
        slTpGroupId,
        hasStopLoss: bothSlTp ? true : isStopLoss || Boolean(cfg.hasStopLoss),
        hasTakeProfit:
          bothSlTp ? true : isTakeProfit || Boolean(cfg.hasTakeProfit),
        stopLossOrderKey:
          cfg.stopLossOrderKey || (isStopLoss ? orderKey : null),
        takeProfitOrderKey:
          cfg.takeProfitOrderKey || (isTakeProfit ? orderKey : null),
        orderType: params.orderType,
        market: params.addresses.market,
        marketSymbol: marketInfo
          ? `${marketInfo.indexTokenSymbol}/${marketInfo.shortTokenSymbol}`
          : cfg.marketSymbol || null,
        indexToken:
          cfg.indexToken || (marketInfo && marketInfo.indexToken) || null,
        isLong,
        sizeDeltaUsd: sizeDeltaUsd.toString(),
        sizeDeltaUsdHuman,
        closePercent:
          cfg.closePercent != null ? Number(cfg.closePercent) : null,
        collateralToken: params.addresses.initialCollateralToken,
        collateralAmount: params.numbers.initialCollateralDeltaAmount,
        triggerPrice: params.numbers.triggerPrice,
        acceptablePrice: params.numbers.acceptablePrice,
        executionFee: params.numbers.executionFee,
        qualifiedTrade: !isStopLoss && !isTakeProfit && !bothSlTp,
        rawParams: {
          orderType: params.orderType,
          isLong: params.isLong,
          numbers: params.numbers,
          addresses: params.addresses,
        },
      })
    }
  } catch (err) {
    console.error('\n=== Transaction failed ===')
    console.error('closePosition multicall failed:', decodeRevertReason(err))
    try {
      await exchangeRouter.callStatic.multicall(multicallArgs, {
        value: executionFee,
      })
    } catch (err2) {
      console.error('callStatic multicall revert:', decodeRevertReason(err2))
    }
    throw err
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
