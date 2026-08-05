/**
 * Add liquidity (Deposit) — approve tokens first, then use multicall to send sendTokens + createDeposit
 *
 * Usage: node scripts/add-liquidity.js <config.json>
 */

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
const erc20Abi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/ERC20.json'), 'utf8'),
).abi
const errorsAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/Errors.json'), 'utf8'),
).abi
const dataStoreAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/abis/DataStore.json'), 'utf8'),
).abi
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/celo-tokens.json'), 'utf8'),
)
const markets = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../assets/markets.json'), 'utf8'),
)
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

function findTokenDecimalsByAddress(tokenAddress) {
  const target = normalizeAddr(tokenAddress)
  for (const meta of Object.values(tokenMeta)) {
    if (normalizeAddr(meta.address) === target) return meta.decimals
  }
  return null
}

function findMarketBySymbol(symbol) {
  return findMarket(markets, symbol)
}

async function main() {
  const configPath = process.argv[2]
  if (!configPath) {
    console.error('Usage: node scripts/add-liquidity.js <config.json>')
    console.error(
      'Example: node scripts/add-liquidity.js assets/orders/add-liquidity-btc.json',
    )
    process.exitCode = 1
    return
  }

  const cfg = readConfig(configPath)
  const rpcUrl = process.env.CELO_RPC_URL
  const privateKey = process.env.CELO_PRIVATE_KEY
  if (!rpcUrl || !privateKey) {
    throw new Error(
      'Missing CELO_RPC_URL or CELO_PRIVATE_KEY in assets/celo.env.local',
    )
  }

  const celo = addresses.celo || addresses
  const depositVault = cfg.depositVault || celo.DepositVault
  const wntAddress = cfg.wnt || celo.WNT
  const routerAddress = celo.Router

  if (!depositVault || !ethers.utils.isAddress(depositVault)) {
    throw new Error(
      'Missing or invalid DepositVault. Set addresses.celo.DepositVault or config.depositVault',
    )
  }
  if (!wntAddress || !ethers.utils.isAddress(wntAddress)) {
    throw new Error(
      'Missing or invalid WNT/fee token. Set addresses.celo.WNT or config.wnt',
    )
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || '42220'),
    name: 'celo',
  })
  const dataStore = new ethers.Contract(celo.DataStore, dataStoreAbi, provider)
  const wallet = new ethers.Wallet(privateKey, provider)
  const account = cfg.receiver || wallet.address

  const exchangeRouter = new ethers.Contract(
    celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet,
  )

  let marketAddress = cfg.market
  let longTokenAddress = cfg.initialLongToken
  let shortTokenAddress = cfg.initialShortToken

  if (!marketAddress && (cfg.marketSymbol || cfg.market)) {
    const m = findMarketBySymbol(cfg.marketSymbol || cfg.market)
    if (!m)
      throw new Error('Market not found: ' + (cfg.marketSymbol || cfg.market))
    marketAddress = m.marketToken
    longTokenAddress = m.longToken
    shortTokenAddress = m.shortToken
  }

  if (!marketAddress || !longTokenAddress || !shortTokenAddress) {
    throw new Error(
      'Config must provide market (or marketSymbol), initialLongToken, initialShortToken',
    )
  }

  const longDecimals = findTokenDecimalsByAddress(longTokenAddress) ?? 18
  const shortDecimals = findTokenDecimalsByAddress(shortTokenAddress) ?? 6

  const longAmount =
    cfg.initialLongTokenAmount ??
    toUnits(cfg.initialLongTokenAmountHuman, longDecimals)
  const shortAmount =
    cfg.initialShortTokenAmount ??
    toUnits(cfg.initialShortTokenAmountHuman, shortDecimals)
  const executionFee = await resolveExecutionFee({
    cfg,
    dataStore,
    provider,
    gasLimitKey: 'DEPOSIT_GAS_LIMIT',
    oraclePriceCount: 3,
    callbackGasLimit: cfg.callbackGasLimit || 0,
  })

  if (!longAmount || !shortAmount || !executionFee) {
    throw new Error(
      'Missing amounts. Set initialLongTokenAmountHuman, initialShortTokenAmountHuman, executionFeeHuman (optional)',
    )
  }

  console.log('\n=== UPDOWN Add Liquidity ===\n')
  console.log('market:', marketAddress)
  console.log(
    'longToken:',
    longTokenAddress,
    'amount:',
    ethers.utils.formatUnits(longAmount, longDecimals),
  )
  console.log(
    'shortToken:',
    shortTokenAddress,
    'amount:',
    ethers.utils.formatUnits(shortAmount, shortDecimals),
  )
  console.log('executionFee:', ethers.utils.formatEther(executionFee))
  console.log('depositVault:', depositVault)
  console.log('receiver:', account)

  const wntContract = new ethers.Contract(wntAddress, erc20Abi, wallet)
  const longContract = new ethers.Contract(longTokenAddress, erc20Abi, wallet)
  const shortContract = new ethers.Contract(shortTokenAddress, erc20Abi, wallet)

  const maxUint = ethers.constants.MaxUint256

  const [
    wntBalance,
    longBalance,
    shortBalance,
    wntAllowance,
    longAllowance,
    shortAllowance,
  ] = await Promise.all([
    wntContract.balanceOf(account),
    longContract.balanceOf(account),
    shortContract.balanceOf(account),
    wntContract.allowance(account, routerAddress),
    longContract.allowance(account, routerAddress),
    shortContract.allowance(account, routerAddress),
  ])

  console.log('\nBalances / Allowances:')
  console.log('  WNT balance:', ethers.utils.formatEther(wntBalance))
  console.log(
    '  Long balance:',
    ethers.utils.formatUnits(longBalance, longDecimals),
  )
  console.log(
    '  Short balance:',
    ethers.utils.formatUnits(shortBalance, shortDecimals),
  )

  if (wntBalance.lt(executionFee)) {
    throw new Error(
      'Insufficient WNT/fee balance, required ' +
        ethers.utils.formatEther(executionFee),
    )
  }
  if (longBalance.lt(longAmount)) {
    throw new Error('Insufficient long token balance')
  }
  if (shortBalance.lt(shortAmount)) {
    throw new Error('Insufficient short token balance')
  }

  if (wntAllowance.lt(executionFee)) {
    console.log('Approving WNT to Router...')
    await ensureAllowance({
      token: wntContract,
      owner: account,
      spender: routerAddress,
      required: executionFee,
      approveAmount: maxUint,
    })
    console.log('  WNT approved')
  }
  if (longAllowance.lt(longAmount)) {
    console.log('Approving long token to Router...')
    await ensureAllowance({
      token: longContract,
      owner: account,
      spender: routerAddress,
      required: longAmount,
      approveAmount: maxUint,
    })
    console.log('  Long token approved')
  }
  if (shortAllowance.lt(shortAmount)) {
    console.log('Approving short token to Router...')
    await ensureAllowance({
      token: shortContract,
      owner: account,
      spender: routerAddress,
      required: shortAmount,
      approveAmount: maxUint,
    })
    console.log('  Short token approved')
  }

  const depositParams = {
    receiver: account,
    callbackContract: ethers.constants.AddressZero,
    uiFeeReceiver: ethers.constants.AddressZero,
    market: marketAddress,
    initialLongToken: longTokenAddress,
    initialShortToken: shortTokenAddress,
    longTokenSwapPath: [],
    shortTokenSwapPath: [],
    minMarketTokens: 0,
    shouldUnwrapNativeToken: false,
    executionFee,
    callbackGasLimit: 0,
  }

  const depositMulticallArgs = [
    exchangeRouter.interface.encodeFunctionData('sendTokens', [
      wntAddress,
      depositVault,
      executionFee,
    ]),
    exchangeRouter.interface.encodeFunctionData('sendTokens', [
      longTokenAddress,
      depositVault,
      longAmount,
    ]),
    exchangeRouter.interface.encodeFunctionData('sendTokens', [
      shortTokenAddress,
      depositVault,
      shortAmount,
    ]),
    exchangeRouter.interface.encodeFunctionData('createDeposit', [
      depositParams,
    ]),
  ]

  console.log('\nSending deposit transaction (multicall)...')

  try {
    await exchangeRouter.callStatic.multicall(depositMulticallArgs, {
      gasLimit: 7000000,
    })
  } catch (err) {
    console.error('callStatic pre-check failed:', decodeRevertReason(err))
    throw err
  }

  const tx = await exchangeRouter.multicall(depositMulticallArgs, {
    gasLimit: 7000000,
  })

  console.log('txHash:', tx.hash)
  console.log('Explorer: https://celoscan.io/tx/' + tx.hash)

  const receipt = await tx.wait()
  console.log(
    'Block:',
    receipt.blockNumber,
    'gasUsed:',
    receipt.gasUsed.toString(),
  )

  const depositCreatedTopic = ethers.utils.id(
    'DepositCreated(bytes32,address,address,address,address,address,address[],address[],uint256,uint256,uint256,bool,uint256,uint256)',
  )
  for (const log of receipt.logs) {
    if (log.topics[0] === depositCreatedTopic) {
      console.log('DepositCreated key:', log.topics[1])
      break
    }
  }

  console.log('\nLiquidity deposit request submitted, waiting for keeper execution.')
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
