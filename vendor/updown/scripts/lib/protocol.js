const { ethers } = require('ethers')

const FACTOR_DENOMINATOR = ethers.BigNumber.from(10).pow(30)
const DEFAULT_EXECUTION_FEE_FALLBACK_CELO = '1.4'
const DEFAULT_EXECUTION_FEE_BUFFER_BPS = 12500

function keyOfString(value) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(['string'], [value]),
  )
}

function applyFactor(value, factor) {
  return ethers.BigNumber.from(value)
    .mul(factor)
    .div(FACTOR_DENOMINATOR)
}

function configuredExecutionFee(cfg = {}) {
  if (cfg.executionFee !== undefined && cfg.executionFee !== null) {
    return ethers.BigNumber.from(cfg.executionFee)
  }
  if (
    cfg.executionFeeHuman !== undefined &&
    cfg.executionFeeHuman !== null &&
    String(cfg.executionFeeHuman).trim() !== ''
  ) {
    return ethers.utils.parseEther(String(cfg.executionFeeHuman))
  }
  return null
}

function fallbackExecutionFee() {
  return ethers.utils.parseEther(
    process.env.UPDOWN_EXECUTION_FEE_FALLBACK_CELO ||
      DEFAULT_EXECUTION_FEE_FALLBACK_CELO,
  )
}

function executionFeeBufferBps() {
  const value = Number(
    process.env.UPDOWN_EXECUTION_FEE_BUFFER_BPS ||
      DEFAULT_EXECUTION_FEE_BUFFER_BPS,
  )
  if (!Number.isInteger(value) || value < 10000) {
    throw new Error('UPDOWN_EXECUTION_FEE_BUFFER_BPS must be an integer >= 10000')
  }
  return value
}

async function estimateExecutionFee({
  dataStore,
  provider,
  gasLimitKey,
  swapCount = 0,
  oraclePriceCount = 3,
  callbackGasLimit = 0,
}) {
  const [
    actionGasLimit,
    singleSwapGasLimit,
    baseGasFee,
    gasFeePerOracle,
    gasFeeMultiplier,
    gasPrice,
  ] = await Promise.all([
    dataStore.getUint(keyOfString(gasLimitKey)),
    dataStore.getUint(keyOfString('SINGLE_SWAP_GAS_LIMIT')),
    dataStore.getUint(keyOfString('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1')),
    dataStore.getUint(keyOfString('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE')),
    dataStore.getUint(keyOfString('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR')),
    provider.getGasPrice(),
  ])

  const estimatedGasLimit = actionGasLimit
    .add(singleSwapGasLimit.mul(swapCount))
    .add(callbackGasLimit)
  const estimatedLimit = baseGasFee
    .add(gasFeePerOracle.mul(oraclePriceCount))
    .add(applyFactor(estimatedGasLimit, gasFeeMultiplier))

  return estimatedLimit.mul(gasPrice)
}

async function resolveExecutionFee({
  cfg = {},
  dataStore,
  provider,
  gasLimitKey,
  swapCount = 0,
  oraclePriceCount = 3,
  callbackGasLimit = 0,
  logger = console,
}) {
  const configured = configuredExecutionFee(cfg)
  let estimated

  try {
    estimated = await estimateExecutionFee({
      dataStore,
      provider,
      gasLimitKey,
      swapCount,
      oraclePriceCount,
      callbackGasLimit,
    })
  } catch (error) {
    if (configured) {
      const fallback = fallbackExecutionFee()
      if (configured.lt(fallback)) {
        throw new Error(
          `Configured execution fee ${ethers.utils.formatEther(
            configured,
          )} CELO is below the offline fallback minimum ${ethers.utils.formatEther(
            fallback,
          )} CELO; on-chain estimation also failed: ${error.message}`,
        )
      }
      logger.warn(
        `Unable to verify configured execution fee from chain: ${error.message}`,
      )
      return configured.toString()
    }
    const fallback = fallbackExecutionFee()
    logger.warn(
      `Unable to estimate execution fee from chain; using ${ethers.utils.formatEther(
        fallback,
      )} CELO fallback: ${error.message}`,
    )
    return fallback.toString()
  }

  const buffered = estimated
    .mul(executionFeeBufferBps())
    .add(9999)
    .div(10000)
  const minimum = buffered.gt(fallbackExecutionFee())
    ? buffered
    : fallbackExecutionFee()

  if (configured && configured.lt(minimum)) {
    throw new Error(
      `Configured execution fee ${ethers.utils.formatEther(
        configured,
      )} CELO is below the current safe minimum ${ethers.utils.formatEther(
        minimum,
      )} CELO`,
    )
  }

  const selected = configured || minimum
  logger.log(
    `executionFee: ${ethers.utils.formatEther(
      selected,
    )} CELO (chain estimate ${ethers.utils.formatEther(
      estimated,
    )}, buffered minimum ${ethers.utils.formatEther(minimum)})`,
  )
  return selected.toString()
}

async function ensureAllowance({
  token,
  owner,
  spender,
  required,
  approveAmount = ethers.constants.MaxUint256,
  confirmations = 1,
  attempts = 5,
  logger = console,
}) {
  const requiredAmount = ethers.BigNumber.from(required)
  let allowance = await token.allowance(owner, spender)
  if (allowance.gte(requiredAmount)) return allowance

  const tx = await token.approve(spender, approveAmount)
  logger.log(`approve tx: ${tx.hash}`)
  await tx.wait(confirmations)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    allowance = await token.allowance(owner, spender)
    if (allowance.gte(requiredAmount)) return allowance
    if (token.provider && token.provider.getBlockNumber) {
      await token.provider.getBlockNumber()
    }
  }

  throw new Error(
    `Allowance did not update after approval: required ${requiredAmount.toString()}, observed ${allowance.toString()}`,
  )
}

function normalizeSymbol(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
}

function findMarket(markets, value) {
  const target = normalizeSymbol(value).replace(/\s+/g, '')
  return (
    markets.find((market) => {
      const index = normalizeSymbol(market.indexTokenSymbol)
      const pair = `${index}/${normalizeSymbol(
        market.shortTokenSymbol || 'USDT',
      )}`
      return target === index || target === pair
    }) || null
  )
}

function findTokenEntry(tokenMeta, value) {
  const target = normalizeSymbol(value)
  return (
    Object.entries(tokenMeta).find(
      ([key, info]) =>
        normalizeSymbol(key) === target ||
        normalizeSymbol(info.symbol) === target,
    ) || null
  )
}

function findTokenDecimalsByAddress(tokenMeta, address) {
  const target = String(address || '').toLowerCase()
  const entry = Object.values(tokenMeta).find(
    (info) => String(info.address || '').toLowerCase() === target,
  )
  return entry ? Number(entry.decimals) : null
}

module.exports = {
  DEFAULT_EXECUTION_FEE_FALLBACK_CELO,
  applyFactor,
  configuredExecutionFee,
  ensureAllowance,
  estimateExecutionFee,
  fallbackExecutionFee,
  findMarket,
  findTokenDecimalsByAddress,
  findTokenEntry,
  keyOfString,
  resolveExecutionFee,
}
