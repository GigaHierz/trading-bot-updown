// One-time setup: grant the UPDOWN Router a max wUSDT allowance so the bot's
// order scripts never hit the interactive approval prompt in CI.
require('dotenv').config({ quiet: true })
const path = require('path')
const { ethers } = require('ethers')

const VENDOR = path.join(__dirname, '../vendor/updown')
const addresses = require(path.join(VENDOR, 'assets/addresses.json')).celo
const tokenMeta = require(path.join(VENDOR, 'assets/celo-tokens.json'))
const erc20Abi = require(path.join(VENDOR, 'assets/abis/ERC20.json')).abi
const { ensureAllowance } = require(path.join(VENDOR, 'scripts/lib/protocol'))

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(process.env.CELO_RPC_URL, {
    chainId: Number(process.env.CELO_CHAIN_ID || 42220),
    name: 'celo',
  })
  const wallet = new ethers.Wallet(process.env.CELO_PRIVATE_KEY, provider)
  const token = new ethers.Contract(tokenMeta.USDT.address, erc20Abi, wallet)

  console.log(`Wallet: ${wallet.address}`)
  const allowance = await ensureAllowance({
    token,
    owner: wallet.address,
    spender: addresses.Router,
    required: ethers.utils.parseUnits('1', tokenMeta.USDT.decimals),
  })
  console.log(
    `wUSDT allowance for Router: ${allowance.gte(ethers.constants.MaxUint256.div(2)) ? 'MAX' : allowance.toString()}`,
  )
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
})
