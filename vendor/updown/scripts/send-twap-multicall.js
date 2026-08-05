const fs = require('fs')
const path = require('path')
const ethers = require('ethers')
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
const dataStoreAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/DataStore.json'), 'utf8'),
).abi
const erc20Abi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/ERC20.json'), 'utf8'),
).abi
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/celo-tokens.json'), 'utf8'),
)

const {
  reportTrade,
  extractOrderKeysFromReceipt,
} = require('./lib/report-trade')
const {
  ensureAllowance,
  findTokenDecimalsByAddress,
  resolveExecutionFee,
} = require('./lib/protocol')

const MAX_UINT256 =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'

function toUnits(value, decimals) {
  if (value === undefined || value === null) return undefined
  return ethers.utils.parseUnits(String(value), decimals).toString()
}

function normalizeAddr(addr) {
  return (addr || '').toLowerCase()
}

// Read TWAP order config files
function readTwapConfigs(twapPattern) {
  const ordersDir = path.join(__dirname, '../orders')

  if (!fs.existsSync(ordersDir)) {
    throw new Error('orders directory not found')
  }

  const files = fs.readdirSync(ordersDir)
  const twapFiles = files
    .filter(
      (f) =>
        f.toLowerCase().includes('twap') &&
        f.toLowerCase().includes(twapPattern.toLowerCase()),
    )
    .sort()

  if (twapFiles.length === 0) {
    throw new Error(`No TWAP orders found for pattern: ${twapPattern}`)
  }

  console.log(`Found ${twapFiles.length} TWAP order files in orders/:`)
  twapFiles.forEach((f) => console.log(`  - ${f}`))

  const configs = twapFiles.map((f) => {
    const configPath = path.join(ordersDir, f)
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  })

  validateTwapGroup(configs, twapFiles)
  return configs
}

/**
 * uiFeeReceiver carries the TWAP group identity: 0xff, then the part count and
 * a group id. Parts missing it — or belonging to different groups, which is what
 * a loose filename pattern silently produces — are created as unrelated limit
 * orders and later cancelled, after locking collateral and execution fees.
 */
function parseTwapUiFeeReceiver(uiFeeReceiver) {
  if (typeof uiFeeReceiver !== 'string') return null
  const value = uiFeeReceiver.toLowerCase()
  if (!/^0xff[0-9a-f]{38}$/.test(value) || !value.endsWith('01')) return null
  return {
    parts: parseInt(value.slice(34, 36), 16),
    groupId: value.slice(36, 40),
  }
}

function validateTwapGroup(configs, twapFiles) {
  const describe = (i) => `${twapFiles[i]}`
  const missing = configs
    .map((cfg, i) => (parseTwapUiFeeReceiver(cfg.uiFeeReceiver) ? null : i))
    .filter((i) => i !== null)

  if (missing.length > 0) {
    throw new Error(
      `Not a TWAP group: ${missing
        .map(describe)
        .join(', ')} has no valid uiFeeReceiver. ` +
        'Generate the parts with scripts/trade-assistant.js instead of writing them by hand.',
    )
  }

  const groups = new Set(
    configs.map((cfg) => parseTwapUiFeeReceiver(cfg.uiFeeReceiver).groupId),
  )
  if (groups.size > 1) {
    throw new Error(
      `Pattern matched ${configs.length} files from ${groups.size} different TWAP groups ` +
        `(${[...groups].join(', ')}). Narrow the pattern so it selects exactly one group.`,
    )
  }

  const declaredParts = parseTwapUiFeeReceiver(configs[0].uiFeeReceiver).parts
  if (declaredParts !== configs.length) {
    throw new Error(
      `TWAP group declares ${declaredParts} parts but the pattern matched ${configs.length} files. ` +
        'Refusing to send an incomplete or duplicated group.',
    )
  }

  const times = configs.map((cfg) => Number(cfg.validFromTime || 0))
  for (let i = 1; i < times.length; i += 1) {
    if (!(times[i] > times[i - 1])) {
      throw new Error(
        `validFromTime must increase across parts: ${describe(i - 1)} (${
          times[i - 1]
        }) → ${describe(i)} (${times[i]}).`,
      )
    }
  }

  console.log(
    `TWAP group ${[...groups][0]} validated: ${configs.length} parts, interval ${
      times[1] - times[0]
    }s`,
  )
}

// Query positions (copied from close-position.js)
async function getPositions(provider, account) {
  const reader = new ethers.Contract(addresses.celo.Reader, readerAbi, provider)

  try {
    const positions = await reader.getAccountPositions(
      addresses.celo.DataStore,
      account,
      0,
      50,
    )
    return positions
  } catch (err) {
    console.log('Failed to query positions:', err.message)
    return []
  }
}

// Find matching position
function findMatchingPosition(positions, cfg) {
  const market = cfg.market
  const isLong = cfg.isLong

  const matches = positions.filter((p) => {
    const marketMatch =
      normalizeAddr(p.addresses.market) === normalizeAddr(market)
    const isLongMatch = p.flags.isLong === isLong
    const collateralMatch =
      !cfg.initialCollateralToken ||
      normalizeAddr(p.addresses.collateralToken) ===
        normalizeAddr(cfg.initialCollateralToken)
    const hasSize = ethers.BigNumber.from(p.numbers.sizeInUsd || 0).gt(0)
    return marketMatch && isLongMatch && collateralMatch && hasSize
  })
  if (matches.length > 1) {
    throw new Error(
      'Multiple positions match this TWAP close; set initialCollateralToken',
    )
  }
  return matches[0]
}

// Build multicall data
async function buildMulticallData(configs, account, exchangeRouter, provider) {
  const multicallArgs = []
  let totalExecutionFee = ethers.BigNumber.from(0)
  const requiredByToken = new Map()
  const dataStore = new ethers.Contract(
    addresses.celo.DataStore,
    dataStoreAbi,
    provider,
  )

  // Query all positions
  const allPositions = await getPositions(provider, account)
  console.log(`\nCurrent total positions: ${allPositions.length}`)

  for (const cfg of configs) {
    const isLong = cfg.isLong
    const isClose = cfg.orderType >= 4 && cfg.orderType <= 6
    const marketInfo = require('../assets/markets.json').find(
      (market) => normalizeAddr(market.marketToken) === normalizeAddr(cfg.market),
    )
    const indexToken = cfg.indexToken || (marketInfo && marketInfo.indexToken)
    const indexTokenDecimals =
      findTokenDecimalsByAddress(tokenMeta, indexToken) ?? 18
    const acceptablePriceDecimals = 30 - indexTokenDecimals

    const executionFee = await resolveExecutionFee({
      cfg,
      dataStore,
      provider,
      gasLimitKey: isClose
        ? 'DECREASE_ORDER_GAS_LIMIT'
        : 'INCREASE_ORDER_GAS_LIMIT',
      swapCount: (cfg.swapPath || []).length,
      oraclePriceCount: 3 + (cfg.swapPath || []).length,
      callbackGasLimit: cfg.callbackGasLimit || 0,
    })
    totalExecutionFee = totalExecutionFee.add(
      ethers.BigNumber.from(executionFee),
    )

    let sizeDeltaUsd, initialCollateralDeltaAmount, initialCollateralToken

    if (isClose) {
      // Close orders: query position info
      const position = findMatchingPosition(allPositions, cfg)

      if (!position) {
        throw new Error(
          `No matching position: ${cfg.market} ${isLong ? 'long' : 'short'}`,
        )
      }

      const positionSizeUsd = ethers.BigNumber.from(position.numbers.sizeInUsd)
      const closePercent = cfg.closePercent || 100

      // Compute close size
      const closeSizeUsd = positionSizeUsd.mul(closePercent).div(100)
      sizeDeltaUsd = closeSizeUsd.toString()

      // Use collateral info from position
      initialCollateralToken = position.addresses.collateralToken
      initialCollateralDeltaAmount = '0' // no need to set for close orders

      console.log(
        `  Position size: ${ethers.utils.formatUnits(positionSizeUsd, 30)} USD`,
      )
      console.log(`  Close percent: ${closePercent}%`)
      console.log(
        `  Close size:    ${ethers.utils.formatUnits(closeSizeUsd, 30)} USD`,
      )
      console.log(`  Collateral token: ${initialCollateralToken}`)
    } else {
      // Open orders
      sizeDeltaUsd = cfg.sizeDeltaUsdHuman
        != null
        ? toUnits(cfg.sizeDeltaUsdHuman, 30)
        : cfg.sizeDeltaUsd || '0'
      const collateralDecimals =
        findTokenDecimalsByAddress(tokenMeta, cfg.initialCollateralToken) ??
        Number(
          await new ethers.Contract(
            cfg.initialCollateralToken,
            erc20Abi,
            provider,
          ).decimals(),
        )
      initialCollateralDeltaAmount =
        cfg.initialCollateralDeltaAmountHuman != null
        ? toUnits(cfg.initialCollateralDeltaAmountHuman, collateralDecimals)
        : cfg.initialCollateralDeltaAmount || '0'
      initialCollateralToken = cfg.initialCollateralToken
      const key = normalizeAddr(initialCollateralToken)
      const current = requiredByToken.get(key) || ethers.BigNumber.from(0)
      requiredByToken.set(
        key,
        current.add(initialCollateralDeltaAmount),
      )
    }

    // TWAP price settings
    let triggerPrice, acceptablePrice
    if (cfg.orderType === 3) {
      // LimitIncrease (open)
      triggerPrice = isLong ? MAX_UINT256 : '0'
      acceptablePrice = isLong ? MAX_UINT256 : '0'
    } else if (cfg.orderType === 5 || cfg.orderType === 6) {
      // LimitDecrease (close) / StopLossDecrease
      triggerPrice = cfg.triggerPrice ?? (isLong ? '0' : MAX_UINT256)
      acceptablePrice = cfg.acceptablePrice ?? (isLong ? '0' : MAX_UINT256)
    } else {
      triggerPrice = cfg.triggerPrice ?? '0'
      acceptablePrice =
        cfg.acceptablePrice ??
        (cfg.acceptablePriceHuman
          ? toUnits(cfg.acceptablePriceHuman, acceptablePriceDecimals)
          : '0')
    }

    // Build order params
    const params = {
      addresses: {
        receiver: cfg.receiver || account,
        cancellationReceiver: cfg.cancellationReceiver || account,
        callbackContract: cfg.callbackContract || ethers.constants.AddressZero,
        uiFeeReceiver: cfg.uiFeeReceiver || ethers.constants.AddressZero,
        market: cfg.market,
        initialCollateralToken: initialCollateralToken,
        swapPath: cfg.swapPath || [],
      },
      numbers: {
        sizeDeltaUsd,
        initialCollateralDeltaAmount,
        triggerPrice,
        acceptablePrice,
        executionFee,
        callbackGasLimit: cfg.callbackGasLimit || '0',
        minOutputAmount: cfg.minOutputAmount || '0',
        validFromTime: cfg.validFromTime || '0',
      },
      orderType: cfg.orderType ?? 2,
      decreasePositionSwapType: 0,
      isLong,
      shouldUnwrapNativeToken: Boolean(cfg.shouldUnwrapNativeToken),
      autoCancel: Boolean(cfg.autoCancel ?? true),
      referralCode: cfg.referralCode || ethers.constants.HashZero,
    }

    // Encode multicall calls
    // 1. sendWnt - send execution fee
    const sendWntData = exchangeRouter.interface.encodeFunctionData('sendWnt', [
      addresses.celo.OrderVault,
      executionFee,
    ])
    multicallArgs.push(sendWntData)

    // 2. sendTokens - send collateral (only for opening; closing does not need this)
    if (!isClose) {
      const sendTokensData = exchangeRouter.interface.encodeFunctionData(
        'sendTokens',
        [
          initialCollateralToken,
          addresses.celo.OrderVault,
          initialCollateralDeltaAmount,
        ],
      )
      multicallArgs.push(sendTokensData)
    }

    // 3. createOrder - create order
    const createOrderData = exchangeRouter.interface.encodeFunctionData(
      'createOrder',
      [params],
    )
    multicallArgs.push(createOrderData)
  }

  for (const [tokenAddress, required] of requiredByToken.entries()) {
    const token = new ethers.Contract(
      tokenAddress,
      erc20Abi,
      exchangeRouter.signer,
    )
    await ensureAllowance({
      token,
      owner: account,
      spender: addresses.celo.Router,
      required,
    })
  }

  return { multicallArgs, totalExecutionFee }
}

// Main
async function main() {
  const twapPattern = process.argv[2] || 'celo-long'

  console.log('=== TWAP Multicall Sender ===\n')
  console.log(`Searching TWAP orders with pattern: ${twapPattern}`)
  console.log('')

  // Initialize provider and wallet
  const rpcUrl = process.env.CELO_RPC_URL
  const privateKey = process.env.CELO_PRIVATE_KEY
  if (!rpcUrl || !privateKey) {
    throw new Error('Missing CELO_RPC_URL or CELO_PRIVATE_KEY')
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || '42220'),
    name: 'celo',
  })
  const wallet = new ethers.Wallet(privateKey, provider)

  console.log('Wallet address:', wallet.address)
  console.log('')

  // Read TWAP configs
  const configs = readTwapConfigs(twapPattern)

  // Initialize ExchangeRouter
  const exchangeRouter = new ethers.Contract(
    addresses.celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet,
  )

  // Build multicall data (now needs provider to query positions)
  const { multicallArgs, totalExecutionFee } = await buildMulticallData(
    configs,
    wallet.address,
    exchangeRouter,
    provider,
  )

  console.log('\n=== Multicall parameters ===')
  console.log(`Sub-calls:      ${multicallArgs.length}`)
  console.log(
    `Total executionFee: ${ethers.utils.formatEther(totalExecutionFee)} CELO`,
  )
  console.log('')

  // Check balance
  const balance = await wallet.getBalance()
  console.log('Wallet CELO balance:', ethers.utils.formatEther(balance), 'CELO')

  if (balance.lt(totalExecutionFee)) {
    console.log('\n❌ Error: insufficient CELO balance')
    console.log(`Required: ${ethers.utils.formatEther(totalExecutionFee)} CELO`)
    console.log(`Current:  ${ethers.utils.formatEther(balance)} CELO`)
    return
  }

  console.log('\n=== Ready to send TWAP Multicall ===')
  console.log('Order sequence:')
  configs.forEach((cfg, i) => {
    const isClose = cfg.orderType >= 4 && cfg.orderType <= 6
    const action = isClose ? 'close' : 'open'
    console.log(
      `  ${i + 1}. ${cfg.marketSymbol || cfg.market} - ${
        cfg.isLong ? 'long' : 'short'
      } - ${action}`,
    )
  })
  console.log('')

  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      value: totalExecutionFee,
    })

    // Send multicall transaction
    const tx = await exchangeRouter.multicall(multicallArgs, {
      value: totalExecutionFee,
    })

    console.log('Transaction submitted:', tx.hash)
    console.log('Waiting for confirmation...')

    const receipt = await tx.wait()

    console.log('\n✅ TWAP Multicall sent successfully!')
    console.log('Block:', receipt.blockNumber)
    console.log('Gas used:', receipt.gasUsed.toString())
    console.log('Explorer:', `https://celoscan.io/tx/${tx.hash}`)

    if (receipt.status === 1) {
      const orderKeys = extractOrderKeysFromReceipt(
        receipt,
        exchangeRouter.interface,
      )
      const totalSizeHuman = configs.reduce((sum, cfg) => {
        const n = Number(cfg.sizeDeltaUsdHuman)
        return sum + (Number.isFinite(n) ? n : 0)
      }, 0)

      await reportTrade({
        action: 'twap_orders',
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        account: wallet.address,
        orderKeys,
        twapPattern,
        twapParts: configs.length,
        executionFee: totalExecutionFee.toString(),
        sizeDeltaUsdHuman: totalSizeHuman > 0 ? String(totalSizeHuman) : null,
        qualifiedTrade: true,
        orders: configs.map((cfg, i) => ({
          part: i + 1,
          orderType: cfg.orderType,
          market: cfg.market || null,
          marketSymbol: cfg.marketSymbol || null,
          isLong: Boolean(cfg.isLong),
          sizeDeltaUsd:
            cfg.sizeDeltaUsdHuman != null
              ? String(cfg.sizeDeltaUsdHuman)
              : cfg.sizeDeltaUsd || null,
          sizeDeltaUsdHuman:
            cfg.sizeDeltaUsdHuman != null
              ? String(cfg.sizeDeltaUsdHuman)
              : null,
          collateralAmount:
            cfg.initialCollateralDeltaAmountHuman != null
              ? String(cfg.initialCollateralDeltaAmountHuman)
              : cfg.initialCollateralDeltaAmount || null,
          triggerPrice:
            cfg.triggerPriceHuman != null
              ? String(cfg.triggerPriceHuman)
              : cfg.triggerPrice || null,
          action:
            cfg.orderType >= 4 && cfg.orderType <= 6 ? 'close' : 'open',
        })),
      })
    }
  } catch (err) {
    console.error('\n❌ Failed to send TWAP Multicall:', err.message)
    if (err.reason) {
      console.error('Reason:', err.reason)
    }
    throw err
  }
}

main().catch((err) => {
  console.error('Error:', err.message)
  process.exit(1)
})
