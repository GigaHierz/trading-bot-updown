const { ethers } = require('ethers')
const { keyOfString } = require('./protocol')

function accountOrderListKey(account) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'address'],
      [keyOfString('ACCOUNT_ORDER_LIST'), account],
    ),
  )
}

function orderFieldKey(orderKey, field) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ['bytes32', 'bytes32'],
      [orderKey, keyOfString(field)],
    ),
  )
}

async function getOrder(dataStore, key) {
  const addressFields = [
    'ACCOUNT',
    'RECEIVER',
    'CANCELLATION_RECEIVER',
    'MARKET',
    'INITIAL_COLLATERAL_TOKEN',
  ]
  const uintFields = [
    'ORDER_TYPE',
    'SIZE_DELTA_USD',
    'INITIAL_COLLATERAL_DELTA_AMOUNT',
    'TRIGGER_PRICE',
    'ACCEPTABLE_PRICE',
    'EXECUTION_FEE',
    'MIN_OUTPUT_AMOUNT',
    'VALID_FROM_TIME',
    'UPDATED_AT_TIME',
  ]
  const boolFields = ['IS_LONG', 'IS_FROZEN', 'AUTO_CANCEL']

  const [addresses, numbers, flags] = await Promise.all([
    Promise.all(
      addressFields.map((field) =>
        dataStore.getAddress(orderFieldKey(key, field)),
      ),
    ),
    Promise.all(
      uintFields.map((field) => dataStore.getUint(orderFieldKey(key, field))),
    ),
    Promise.all(
      boolFields.map((field) => dataStore.getBool(orderFieldKey(key, field))),
    ),
  ])

  return {
    key,
    account: addresses[0],
    receiver: addresses[1],
    cancellationReceiver: addresses[2],
    market: addresses[3],
    initialCollateralToken: addresses[4],
    orderType: Number(numbers[0]),
    sizeDeltaUsd: numbers[1],
    initialCollateralDeltaAmount: numbers[2],
    triggerPrice: numbers[3],
    acceptablePrice: numbers[4],
    executionFee: numbers[5],
    minOutputAmount: numbers[6],
    validFromTime: numbers[7],
    updatedAtTime: numbers[8],
    isLong: flags[0],
    isFrozen: flags[1],
    autoCancel: flags[2],
  }
}

async function getAccountOrders(dataStore, account, start = 0, end = 50) {
  const setKey = accountOrderListKey(account)
  const count = Number(await dataStore.getBytes32Count(setKey))
  const boundedEnd = Math.min(end, count)
  if (start >= boundedEnd) return []
  const keys = await dataStore.getBytes32ValuesAt(setKey, start, boundedEnd)
  return Promise.all(keys.map((key) => getOrder(dataStore, key)))
}

module.exports = {
  accountOrderListKey,
  getAccountOrders,
  getOrder,
  orderFieldKey,
}
