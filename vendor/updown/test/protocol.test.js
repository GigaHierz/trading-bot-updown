const test = require('node:test')
const assert = require('node:assert/strict')
const { ethers } = require('ethers')

const {
  ensureAllowance,
  estimateExecutionFee,
  resolveExecutionFee,
} = require('../scripts/lib/protocol')

function fakeDataStore(values) {
  return {
    getUint(key) {
      const value = values[key]
      if (value === undefined) throw new Error(`Missing fake key ${key}`)
      return Promise.resolve(ethers.BigNumber.from(value))
    },
  }
}

test('execution fee estimate tracks gas price and on-chain parameters', async () => {
  const { keyOfString } = require('../scripts/lib/protocol')
  const values = {
    [keyOfString('INCREASE_ORDER_GAS_LIMIT')]: 100,
    [keyOfString('SINGLE_SWAP_GAS_LIMIT')]: 20,
    [keyOfString('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1')]: 10,
    [keyOfString('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE')]: 5,
    [keyOfString('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR')]:
      ethers.BigNumber.from(10).pow(30),
  }
  const fee = await estimateExecutionFee({
    dataStore: fakeDataStore(values),
    provider: { getGasPrice: async () => ethers.BigNumber.from(2) },
    gasLimitKey: 'INCREASE_ORDER_GAS_LIMIT',
    swapCount: 1,
    oraclePriceCount: 4,
  })
  assert.equal(fee.toString(), '300')
})

test('unsafe explicit execution fee is rejected', async () => {
  const { keyOfString } = require('../scripts/lib/protocol')
  const values = {
    [keyOfString('DECREASE_ORDER_GAS_LIMIT')]: 1000000,
    [keyOfString('SINGLE_SWAP_GAS_LIMIT')]: 0,
    [keyOfString('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1')]: 0,
    [keyOfString('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE')]: 0,
    [keyOfString('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR')]:
      ethers.BigNumber.from(10).pow(30),
  }
  await assert.rejects(
    resolveExecutionFee({
      cfg: { executionFeeHuman: 0.2 },
      dataStore: fakeDataStore(values),
      provider: {
        getGasPrice: async () => ethers.utils.parseUnits('200', 'gwei'),
      },
      gasLimitKey: 'DECREASE_ORDER_GAS_LIMIT',
      logger: { log() {}, warn() {} },
    }),
    /below the current safe minimum/,
  )
})

test('allowance is re-read after approval confirmation', async () => {
  let reads = 0
  let waited = false
  const token = {
    provider: { getBlockNumber: async () => 1 },
    allowance: async () => {
      reads += 1
      return ethers.BigNumber.from(reads >= 3 ? 100 : 0)
    },
    approve: async () => ({
      hash: '0xabc',
      wait: async () => {
        waited = true
      },
    }),
  }
  const allowance = await ensureAllowance({
    token,
    owner: ethers.constants.AddressZero,
    spender: ethers.constants.AddressZero,
    required: 100,
    logger: { log() {} },
  })
  assert.equal(waited, true)
  assert.equal(reads, 3)
  assert.equal(allowance.toString(), '100')
})
