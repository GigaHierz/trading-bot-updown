const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
const readline = require('readline')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

const MAX_UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'

const addresses = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/addresses.json'), 'utf8'),
)
const exchangeRouterAbi = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../assets/abis/ExchangeRouter.json'),
    'utf8',
  ),
).abi
const erc20Abi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/ERC20.json'), 'utf8'),
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
const chainlinkAbi = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../assets/abis/ChainlinkFeed.json'),
    'utf8',
  ),
).abi
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/celo-tokens.json'), 'utf8'),
)
const { reportTrade } = require('./lib/report-trade')
const {
  ensureAllowance,
  findMarket,
  resolveExecutionFee,
} = require('./lib/protocol')

function decodeRevertReason(error) {
  const data =
    error?.error?.data ||
    error?.data ||
    error?.error?.error?.data ||
    error?.receipt?.revertReason
  if (!data || typeof data !== 'string') {
    return 'Unknown revert reason'
  }
  try {
    const iface = new ethers.utils.Interface(errorsAbi)
    const parsed = iface.parseError(data)
    return `${parsed.name}(${parsed.args.map((x) => x.toString()).join(', ')})`
  } catch {}
  if (data.startsWith('0x08c379a0')) {
    try {
      const reason = ethers.utils.defaultAbiCoder.decode(
        ['string'],
        '0x' + data.slice(10),
      )[0]
      return reason
    } catch {
      return 'Reverted (string decode failed)'
    }
  }
  return 'Reverted (no string reason)'
}

function promptYesNo(message) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    rl.question(message, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase() === 'yes')
    })
  })
}

function readConfig(configPath) {
  const fullPath = path.resolve(process.cwd(), configPath)
  const cfg = JSON.parse(fs.readFileSync(fullPath, 'utf8'))

  // If marketSymbol is configured (e.g. "EURm/USDT"), automatically find the corresponding market address
  if (cfg.marketSymbol && !cfg.market) {
    const markets = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
    )
    const matchedMarket = findMarket(markets, cfg.marketSymbol)

    if (matchedMarket) {
      cfg.market = matchedMarket.marketToken
      cfg.indexToken = matchedMarket.indexToken
      cfg.initialCollateralToken =
        cfg.initialCollateralToken || matchedMarket.shortToken
      console.log(
        `✅ Found market address by symbol "${cfg.marketSymbol}":`,
        cfg.market,
      )
    } else {
      throw new Error(
        `Market symbol "${cfg.marketSymbol}" not found, please check markets.json or set market address manually`,
      )
    }
  }

  return cfg
}

function toUnits(value, decimals) {
  if (value === undefined || value === null) return undefined
  return ethers.utils.parseUnits(String(value), decimals).toString()
}

function normalizeAddr(addr) {
  return (addr || '').toLowerCase()
}

function findMarketInfo(marketToken) {
  const target = normalizeAddr(marketToken)
  const markets = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
  )
  return markets.find((m) => normalizeAddr(m.marketToken) === target) || null
}

function findTokenDecimalsByAddress(tokenAddress) {
  const target = normalizeAddr(tokenAddress)
  for (const meta of Object.values(tokenMeta)) {
    if (normalizeAddr(meta.address) === target) return meta.decimals
  }
  return null
}

function keyOfString(value) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['string'], [value]),
  )
}

function keyOfBaseAndParams(baseKey, types, values) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', ...types],
      [baseKey, ...values],
    ),
  )
}

function isTrue(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
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

  const account = cfg.account || wallet.address
  const spender = addresses.celo.Router
  const isLong = isTrue(cfg.isLong)
  const orderVault = cfg.orderVault || addresses.celo.OrderVault
  if (!orderVault) {
    throw new Error(
      'Missing OrderVault address (set assets/addresses.json or config.orderVault)',
    )
  }

  // ===== Position checks and collateral validation =====
  // For all MarketIncrease orders: validate by market + side + collateral
  const orderType = cfg.orderType ?? 2

  // Only check open-position order types (MarketIncrease=2, LimitIncrease=3, StopIncrease=8)
  if (orderType === 2 || orderType === 3 || orderType === 8) {
    const marketInfo = findMarketInfo(cfg.market)
    const marketLabel = marketInfo
      ? `${marketInfo.indexTokenSymbol}-${marketInfo.shortTokenSymbol}`
      : cfg.market.substring(0, 10) + '...'
    const directionLabel = isLong ? 'Long' : 'Short'

    // Resolve collateral token info
    let collateralSymbol = 'Unknown'
    if (cfg.initialCollateralToken) {
      const normalizedCollateral = normalizeAddr(cfg.initialCollateralToken)
      for (const [symbol, info] of Object.entries(tokenMeta)) {
        if (normalizeAddr(info.address) === normalizedCollateral) {
          collateralSymbol = symbol
          break
        }
      }
      if (collateralSymbol === 'Unknown') {
        collateralSymbol = cfg.initialCollateralToken.substring(0, 10) + '...'
      }
    }

    console.log(
      `\n=== Position check (${marketLabel} ${directionLabel}, ${collateralSymbol} collateral) ===`,
    )

    // Query existing positions
    const readerAbi = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../assets/abis/Reader.json'),
        'utf8',
      ),
    ).abi
    const reader = new ethers.Contract(
      addresses.celo.Reader,
      readerAbi,
      provider,
    )

    try {
      const allPositions = await reader.getAccountPositions(
        addresses.celo.DataStore,
        account,
        0,
        50,
      )

      // Filter positions: same market + same side + same collateral + non-zero size
      const targetPositions = allPositions.filter((p) => {
        const marketMatch =
          normalizeAddr(p.addresses.market) === normalizeAddr(cfg.market)
        const isLongMatch = p.flags.isLong === isLong
        const collateralMatch =
          normalizeAddr(p.addresses.collateralToken) ===
          normalizeAddr(cfg.initialCollateralToken)
        const hasSize = ethers.BigNumber.from(p.numbers.sizeInUsd || 0).gt(0)
        return marketMatch && isLongMatch && collateralMatch && hasSize
      })

      console.log('  Total positions:', allPositions.length)
      console.log('  Matching positions:', targetPositions.length)

      if (targetPositions.length === 0) {
        const collateralAmount = parseFloat(
          cfg.initialCollateralDeltaAmountHuman || 0,
        )
        console.log('  Collateral amount:', collateralAmount, collateralSymbol)
        console.log(
          'No matching position exists; protocol minimums will be checked on-chain.',
        )
      } else {
        // There is already a matching position
        const positionSize = ethers.utils.formatUnits(
          targetPositions[0].numbers.sizeInUsd,
          30,
        )
        console.log(
          `✅ Matching position found, current size: ${positionSize} USD`,
        )
      }
    } catch (err) {
      console.log('  Failed to query positions:', err.message)
    }
    console.log('')
  }

  // ===== Trigger price hints for limit/stop orders =====
  if (orderType === 3 || orderType === 8) {
    // LimitIncrease or StopIncrease
    const triggerPriceHuman = cfg.triggerPriceHuman
    if (triggerPriceHuman !== undefined && triggerPriceHuman !== null) {
      console.log('=== ⚠️  Trigger Price Notice ===')
      console.log(`  triggerPrice: ${triggerPriceHuman} USD`)

      if (orderType === 3) {
        // LimitIncrease
        if (isLong) {
          console.log(
            '  Condition: execute limit buy when price ≤ triggerPrice',
          )
        } else {
          console.log(
            '  Condition: execute limit sell when price ≥ triggerPrice',
          )
        }
      } else if (orderType === 8) {
        // StopIncrease
        if (isLong) {
          console.log(
            '  Condition: execute stop-market buy when price ≥ triggerPrice',
          )
        } else {
          console.log(
            '  Condition: execute stop-market sell when price ≤ triggerPrice',
          )
        }
      }

      console.log('  Please double-check that triggerPrice is correct!')
      console.log('')
    }
  }

  // Decide payment token and collateral token
  // Case 1: payment token == collateral token - use initialCollateralToken as payment token
  // Case 2: payment token != collateral token - requires swapPath;
  //         initialCollateralToken is payment, swapPath[0] market’s long/short token is collateral
  let paymentTokenAddress
  let actualCollateralTokenAddress

  if (cfg.swapPath && cfg.swapPath.length > 0) {
    // swapPath exists -> need a swap
    // initialCollateralToken is the payment token
    // collateral token depends on market and side
    paymentTokenAddress = cfg.initialCollateralToken

    // Find market info from markets.json to resolve collateral token
    const markets = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
    )
    const swapMarket = markets.find(
      (m) => m.marketToken.toLowerCase() === cfg.swapPath[0].toLowerCase(),
    )

    if (swapMarket) {
      // Direction decides collateral:
      // Long: longToken is collateral; Short: shortToken is collateral
      actualCollateralTokenAddress = isLong
        ? swapMarket.longToken
        : swapMarket.shortToken
      console.log('swapPath detected, will swap tokens:')
      console.log('  payment token:', paymentTokenAddress)
      console.log('  collateral token:', actualCollateralTokenAddress)
      console.log('  swap market:', cfg.swapPath[0])
      console.log(
        '  side:',
        isLong
          ? 'long (use longToken as collateral)'
          : 'short (use shortToken as collateral)',
      )
    } else {
      console.log('Warning: no market info found for swapPath[0]')
      actualCollateralTokenAddress = cfg.initialCollateralToken
    }
  } else {
    // No swapPath: payment and collateral tokens are the same
    paymentTokenAddress = cfg.initialCollateralToken
    actualCollateralTokenAddress = cfg.initialCollateralToken
    console.log('Payment and collateral tokens are identical:')
    console.log('  token address:', paymentTokenAddress)
  }

  const collateralToken = new ethers.Contract(
    paymentTokenAddress,
    erc20Abi,
    wallet,
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
  const dataStore = new ethers.Contract(
    addresses.celo.DataStore,
    dataStoreAbi,
    provider,
  )

  const collateralDecimals =
    findTokenDecimalsByAddress(paymentTokenAddress) ??
    (await collateralToken.decimals())
  const indexTokenDecimals = findTokenDecimalsByAddress(cfg.indexToken) ?? 8
  const acceptablePriceDecimals = 30 - Number(indexTokenDecimals)
  console.log('indexTokenDecimals:', indexTokenDecimals)
  console.log('acceptablePriceDecimals:', acceptablePriceDecimals)
  if (acceptablePriceDecimals < 0) {
    throw new Error(
      'Invalid index token decimals for acceptablePrice conversion',
    )
  }

  // Handle triggerPrice: support triggerPriceHuman (using acceptablePriceDecimals)
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

  // StopIncrease trigger direction
  if (cfg.orderType === 8) {
    console.log(
      'StopIncrease trigger direction:',
      isLong
        ? 'Above (price crosses upward)'
        : 'Below (price crosses downward)',
    )
  }

  const sizeDeltaUsd = cfg.sizeDeltaUsd ?? toUnits(cfg.sizeDeltaUsdHuman, 30)
  const executionFee = await resolveExecutionFee({
    cfg,
    dataStore,
    provider,
    gasLimitKey: 'INCREASE_ORDER_GAS_LIMIT',
    swapCount: (cfg.swapPath || []).length,
    oraclePriceCount: 3 + (cfg.swapPath || []).length,
    callbackGasLimit: cfg.callbackGasLimit || 0,
  })
  const initialCollateralDeltaAmount =
    cfg.initialCollateralDeltaAmount ??
    toUnits(cfg.initialCollateralDeltaAmountHuman, collateralDecimals)

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
      cfg.indexToken,
      '0x',
    )
    return {
      source: `ChainlinkPriceFeedProvider ${chainlinkPriceFeedProviderAddress}`,
      price,
    }
  }

  // Handle acceptablePrice
  let acceptablePrice

  // Special handling for StopIncrease: long=MaxUint256, short=0
  if (cfg.orderType === 8) {
    // StopIncrease
    acceptablePrice = isLong ? MAX_UINT256 : '0'
    console.log(
      'StopIncrease acceptablePrice:',
      isLong ? 'MAX_UINT256 (long)' : '0 (short)',
    )
  } else if (cfg.orderType === 2) {
    // MarketIncrease: market order, auto-compute from ChainlinkPriceFeedProvider
    console.log(
      'MarketIncrease: auto-computing acceptablePrice via ChainlinkPriceFeedProvider',
    )
    const { source, price } = await getReferenceOraclePrice()
    const mid = price.min.add(price.max).div(2)
    console.log('oracle price min:', ethers.utils.formatUnits(price.min, 30))
    console.log('oracle price max:', ethers.utils.formatUnits(price.max, 30))
    console.log('oracle price mid:', ethers.utils.formatUnits(mid, 30))
    // Long: +3% (upper bound when buying)
    // Short: -3% (lower bound when selling)
    const adjusted = isLong ? mid.mul(103).div(100) : mid.mul(97).div(100)
    acceptablePrice = adjusted.toString()
    console.log(`oracle provider: ${source}`)
    console.log(
      `acceptablePrice auto-set (${isLong ? 'long +3%' : 'short -3%'}):`,
      ethers.utils.formatUnits(adjusted, acceptablePriceDecimals),
    )
    console.log('acceptablePrice (raw):', acceptablePrice)
  } else {
    // LimitIncrease/StopIncrease: use configured acceptablePrice or acceptablePriceHuman
    acceptablePrice =
      cfg.acceptablePrice ??
      toUnits(cfg.acceptablePriceHuman, acceptablePriceDecimals)
    console.log('acceptablePrice from config:', acceptablePrice)
  }

  if (
    !sizeDeltaUsd ||
    !acceptablePrice ||
    !executionFee ||
    !initialCollateralDeltaAmount
  ) {
    throw new Error('Missing required values')
  }

  const [decimals, symbol, balance, allowance] = await Promise.all([
    collateralToken.decimals(),
    collateralToken.symbol().catch(() => 'TOKEN'),
    collateralToken.balanceOf(account),
    collateralToken.allowance(account, spender),
  ])

  console.log('wallet:', account)
  console.log('collateral token:', symbol, cfg.initialCollateralToken)
  console.log(
    'balance:',
    balance.toString(),
    `(${ethers.utils.formatUnits(balance, decimals)})`,
  )
  console.log(
    'allowance:',
    allowance.toString(),
    `(${ethers.utils.formatUnits(allowance, decimals)})`,
    'spender:',
    spender,
  )

  if (isTrue(cfg.skipOracleCheck)) {
    console.log('Oracle price check skipped by config (skipOracleCheck=true)')
  } else {
    try {
      let price
      if (!chainlinkPriceFeedProvider) {
        throw new Error('ChainlinkPriceFeedProvider not available')
      }
      price = await chainlinkPriceFeedProvider.getOraclePrice(
        cfg.indexToken,
        '0x',
      )
      console.log(
        'oracle provider: ChainlinkPriceFeedProvider',
        chainlinkPriceFeedProviderAddress,
      )
      const mid = price.min.add(price.max).div(2)
      console.log(
        'oracle price:',
        'min',
        ethers.utils.formatUnits(price.min, 30),
        'max',
        ethers.utils.formatUnits(price.max, 30),
        'mid',
        ethers.utils.formatUnits(mid, 30),
      )
    } catch (err) {
      console.log('oracle price read failed:', decodeRevertReason(err))
    }
  }

  if (cfg.chainlinkFeed && cfg.chainlinkFeed !== ethers.constants.AddressZero) {
    try {
      const feed = new ethers.Contract(
        cfg.chainlinkFeed,
        chainlinkAbi,
        provider,
      )
      const [feedDecimals, round] = await Promise.all([
        feed.decimals(),
        feed.latestRoundData(),
      ])
      console.log(
        'chainlink price:',
        ethers.utils.formatUnits(round.answer, feedDecimals),
        'updatedAt',
        round.updatedAt.toString(),
      )
    } catch (err) {
      console.log('chainlink price read failed:', decodeRevertReason(err))
    }
  }

  try {
    const minPositionSizeUsd = await dataStore.getUint(
      keyOfString('MIN_POSITION_SIZE_USD'),
    )
    console.log(
      'minPositionSizeUsd:',
      ethers.utils.formatUnits(minPositionSizeUsd, 30),
    )

    const maxOpenInterestKey = keyOfBaseAndParams(
      keyOfString('MAX_OPEN_INTEREST'),
      ['address', 'bool'],
      [cfg.market, Boolean(cfg.isLong)],
    )
    const maxOpenInterest = await dataStore.getUint(maxOpenInterestKey)
    console.log(
      'maxOpenInterest (market/side):',
      ethers.utils.formatUnits(maxOpenInterest, 30),
    )
  } catch (err) {
    console.log('limit checks failed:', decodeRevertReason(err))
  }

  if (ethers.BigNumber.from(allowance).lt(initialCollateralDeltaAmount)) {
    const ok = await promptYesNo(
      'Allowance is insufficient, run approve first? Type yes to continue: ',
    )
    if (!ok) throw new Error('Approval declined; order was not submitted')
    await ensureAllowance({
      token: collateralToken,
      owner: account,
      spender,
      required: initialCollateralDeltaAmount,
      approveAmount: initialCollateralDeltaAmount,
    })
  }

  const params = {
    addresses: {
      receiver: cfg.receiver || account,
      cancellationReceiver: cfg.cancellationReceiver || account,
      callbackContract: cfg.callbackContract || ethers.constants.AddressZero,
      uiFeeReceiver: cfg.uiFeeReceiver || ethers.constants.AddressZero,
      market: cfg.market,
      initialCollateralToken: cfg.initialCollateralToken,
      swapPath: cfg.swapPath || [],
    },
    numbers: {
      sizeDeltaUsd,
      initialCollateralDeltaAmount,
      triggerPrice: triggerPrice,
      acceptablePrice,
      executionFee,
      callbackGasLimit: cfg.callbackGasLimit || '0',
      minOutputAmount: cfg.minOutputAmount || '0',
      validFromTime: cfg.validFromTime || '0',
    },
    // Default to MarketIncrease (2), but prefer cfg.orderType from config file
    orderType: cfg.orderType ?? 2,
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
    exchangeRouter.interface.encodeFunctionData('sendTokens', [
      paymentTokenAddress,
      orderVault,
      initialCollateralDeltaAmount,
    ]),
    exchangeRouter.interface.encodeFunctionData('createOrder', [params]),
  ]

  // Print order parameters
  console.log('\n=== Order parameters ===')
  console.log(
    JSON.stringify(
      params,
      (key, value) => {
        if (
          typeof value === 'bigint' ||
          (typeof value === 'string' && value.length > 20)
        ) {
          return value.toString().substring(0, 50) + '...'
        }
        return value
      },
      2,
    ),
  )
  console.log('\n=== multicall parameters ===')
  console.log('multicallArgs:', multicallArgs)
  console.log('executionFee:', executionFee.toString())

  // Check dry-run mode
  if (process.argv.includes('--dry-run')) {
    console.log(
      '\n⚠️  --dry-run mode: only print parameters, do not execute transaction',
    )
    return
  }

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
      '\nNote: order has been created and is waiting for keeper execution...',
    )
    console.log(
      'After execution completes, you can query positions to check position status',
    )

    if (receipt.status === 1) {
      const marketInfo = findMarketInfo(cfg.market)
      await reportTrade({
        action: 'open_position',
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        account,
        orderKey,
        positionKey: cfg.positionKey || null,
        orderType: params.orderType,
        market: cfg.market,
        marketSymbol: marketInfo
          ? `${marketInfo.indexTokenSymbol}/${marketInfo.shortTokenSymbol}`
          : cfg.marketSymbol || null,
        indexToken:
          cfg.indexToken || (marketInfo && marketInfo.indexToken) || null,
        isLong,
        sizeDeltaUsd: params.numbers.sizeDeltaUsd,
        sizeDeltaUsdHuman:
          cfg.sizeDeltaUsdHuman != null
            ? String(cfg.sizeDeltaUsdHuman)
            : null,
        collateralToken: params.addresses.initialCollateralToken,
        collateralAmount:
          cfg.initialCollateralDeltaAmountHuman != null
            ? String(cfg.initialCollateralDeltaAmountHuman)
            : params.numbers.initialCollateralDeltaAmount,
        triggerPrice: params.numbers.triggerPrice,
        acceptablePrice: params.numbers.acceptablePrice,
        executionFee: params.numbers.executionFee,
        swapPath: params.addresses.swapPath || [],
        qualifiedTrade: true,
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
    console.error('openPosition multicall failed:', decodeRevertReason(err))
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
