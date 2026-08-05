const path = require('path')
const { ethers } = require('ethers')

const VENDOR = path.join(__dirname, '../../vendor/updown')
const addresses = require(path.join(VENDOR, 'assets/addresses.json')).celo
const markets = require(path.join(VENDOR, 'assets/markets.json'))
const tokenMeta = require(path.join(VENDOR, 'assets/celo-tokens.json'))
const readerAbi = require(path.join(VENDOR, 'assets/abis/Reader.json')).abi
const dataStoreAbi = require(path.join(VENDOR, 'assets/abis/DataStore.json')).abi
const priceProviderAbi = require(
  path.join(VENDOR, 'assets/abis/ChainlinkPriceFeedProvider.json'),
).abi
const { getAccountOrders } = require(path.join(VENDOR, 'scripts/lib/order-store'))
const { keyOfString } = require(path.join(VENDOR, 'scripts/lib/protocol'))

const ERC20_VIEW_ABI = ['function balanceOf(address) view returns (uint256)']
const WUSDT = tokenMeta.USDT // platform collateral token (wrapped USDT)

function marketBySymbol(symbol) {
  const m = markets.find((x) => x.indexTokenSymbol === symbol)
  if (!m) throw new Error(`Unknown market symbol: ${symbol}`)
  return m
}

function symbolByMarketToken(marketToken) {
  const m = markets.find(
    (x) => x.marketToken.toLowerCase() === String(marketToken).toLowerCase(),
  )
  return m ? m.indexTokenSymbol : null
}

function indexDecimals(symbol) {
  return tokenMeta[symbol] ? Number(tokenMeta[symbol].decimals) : 18
}

function getProvider() {
  return new ethers.providers.JsonRpcProvider(process.env.CELO_RPC_URL, {
    chainId: Number(process.env.CELO_CHAIN_ID || 42220),
    name: 'celo',
  })
}

function getWalletAddress(provider) {
  return new ethers.Wallet(process.env.CELO_PRIVATE_KEY, provider).address
}

async function oraclePrice(provider, symbol) {
  const feed = new ethers.Contract(
    addresses.ChainlinkPriceFeedProvider,
    priceProviderAbi,
    provider,
  )
  const market = marketBySymbol(symbol)
  const price = await feed.getOraclePrice(market.indexToken, '0x')
  const mid = price.min.add(price.max).div(2)
  // GMX price precision: value * 10^(30 - indexTokenDecimals).
  return Number(ethers.utils.formatUnits(mid, 30 - indexDecimals(symbol)))
}

// Full on-chain snapshot the reconciler and risk gates work from.
async function snapshot(symbols) {
  const provider = getProvider()
  const account = getWalletAddress(provider)
  const reader = new ethers.Contract(addresses.Reader, readerAbi, provider)
  const dataStore = new ethers.Contract(addresses.DataStore, dataStoreAbi, provider)
  const wusdt = new ethers.Contract(WUSDT.address, ERC20_VIEW_ABI, provider)

  const [celoRaw, wusdtRaw, rawPositions, rawOrders, minPosRaw, ...prices] =
    await Promise.all([
      provider.getBalance(account),
      wusdt.balanceOf(account),
      reader.getAccountPositions(addresses.DataStore, account, 0, 50),
      getAccountOrders(dataStore, account, 0, 50),
      dataStore.getUint(keyOfString('MIN_POSITION_SIZE_USD')).catch(() => null),
      ...symbols.map((s) => oraclePrice(provider, s)),
    ])

  const positions = rawPositions
    .filter((p) => ethers.BigNumber.from(p.numbers.sizeInUsd || 0).gt(0))
    .map((p) => ({
      market: symbolByMarketToken(p.addresses.market),
      marketToken: p.addresses.market,
      collateralToken: p.addresses.collateralToken,
      isLong: p.flags.isLong,
      sizeUsd: Number(ethers.utils.formatUnits(p.numbers.sizeInUsd, 30)),
      collateralUsd: Number(
        ethers.utils.formatUnits(p.numbers.collateralAmount, WUSDT.decimals),
      ),
    }))

  const orders = rawOrders.map((o) => ({
    key: o.key,
    market: symbolByMarketToken(o.market),
    orderType: o.orderType,
    isLong: o.isLong,
    sizeUsd: Number(ethers.utils.formatUnits(o.sizeDeltaUsd, 30)),
    updatedAtTime: Number(o.updatedAtTime.toString()),
  }))

  const priceMap = {}
  symbols.forEach((s, i) => {
    priceMap[s] = prices[i]
  })

  return {
    account,
    celoBalance: Number(ethers.utils.formatEther(celoRaw)),
    wusdtBalance: Number(ethers.utils.formatUnits(wusdtRaw, WUSDT.decimals)),
    positions,
    orders,
    prices: priceMap,
    minPositionSizeUsd: minPosRaw
      ? Number(ethers.utils.formatUnits(minPosRaw, 30))
      : null,
  }
}

module.exports = {
  snapshot,
  oraclePrice,
  getProvider,
  marketBySymbol,
  symbolByMarketToken,
  WUSDT,
  addresses,
}
