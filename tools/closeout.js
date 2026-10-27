// Close-out of the experiment: convert the platform collateral back to native
// USDT, revoke the trading allowance, and sweep every balance to one address.
//
//   node tools/closeout.js --phase dry   --to 0x...   # balances + planned actions, no tx
//   node tools/closeout.js --phase swap  --to 0x...   # wUSDT -> native USDT via Bridgers
//   node tools/closeout.js --phase sweep --to 0x...   # revoke allowance, send all tokens + CELO
//
// The signing key travels via env only (CELO_PRIVATE_KEY), same as the bot.
// The destination must be passed explicitly and is echoed back checksummed.
require('dotenv').config({ quiet: true })
const path = require('path')
const { execFile } = require('child_process')
const { ethers } = require('ethers')

const VENDOR = path.join(__dirname, '../vendor/updown')
const addresses = require(path.join(VENDOR, 'assets/addresses.json')).celo
const tokenMeta = require(path.join(VENDOR, 'assets/celo-tokens.json'))

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

// Everything the wallet accumulated over the experiment. wUSDT is listed so a
// swap remainder is swept too; wCELO/wETH/wBTC are platform wrappers with no
// on-chain redemption and are below the Bridgers minimum — swept as-is.
const TOKENS = [
  { symbol: 'USDT', address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' },
  { symbol: 'wUSDT', address: tokenMeta.USDT.address },
  { symbol: 'wARS', address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D' },
  { symbol: 'wBRL', address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0' },
  { symbol: 'cUSD', address: '0x765DE816845861e75A25fCA122bb6898B8B1282a' },
  { symbol: 'USDC', address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' },
  { symbol: 'SLICE', address: '0x2c4AeBd1d2b201B77518ABEA2e5156ED851CC529' },
  { symbol: 'wCELO', address: tokenMeta.CELO.address },
  { symbol: 'wETH', address: tokenMeta.ETH.address },
  { symbol: 'wBTC', address: tokenMeta.BTC.address },
]

const CELO_GAS_RESERVE = ethers.utils.parseEther('0.5')
const SWAP_WAIT_MS = 20 * 60 * 1000
const SWAP_POLL_MS = 30 * 1000

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function provider() {
  return new ethers.providers.JsonRpcProvider(process.env.CELO_RPC_URL, {
    chainId: Number(process.env.CELO_CHAIN_ID || 42220),
    name: 'celo',
  })
}

function signer(p) {
  if (!process.env.CELO_PRIVATE_KEY) throw new Error('signing key missing from env')
  return new ethers.Wallet(process.env.CELO_PRIVATE_KEY, p)
}

async function balances(p, owner) {
  const out = []
  for (const t of TOKENS) {
    const c = new ethers.Contract(t.address, ERC20_ABI, p)
    const [raw, dec] = await Promise.all([c.balanceOf(owner), c.decimals()])
    out.push({ ...t, raw, decimals: dec, human: ethers.utils.formatUnits(raw, dec) })
  }
  const celo = await p.getBalance(owner)
  return { tokens: out, celo }
}

function printBalances(label, b) {
  console.log(`\n## ${label}`)
  console.log(`CELO (native): ${ethers.utils.formatEther(b.celo)}`)
  for (const t of b.tokens) if (!t.raw.isZero()) console.log(`${t.symbol}: ${t.human}`)
}

function runVendor(script, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(VENDOR, 'scripts', script), ...args],
      { cwd: VENDOR, env: process.env, timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        process.stdout.write(String(stdout))
        if (stderr) process.stderr.write(String(stderr))
        if (error) reject(new Error(`${script} failed: ${error.message}`))
        else resolve(String(stdout))
      },
    )
    child.stdin.end()
  })
}

async function phaseSwap(p, wallet) {
  const wusdt = new ethers.Contract(tokenMeta.USDT.address, ERC20_ABI, p)
  const usdt = new ethers.Contract(TOKENS[0].address, ERC20_ABI, p)
  const before = await usdt.balanceOf(wallet.address)
  const raw = await wusdt.balanceOf(wallet.address)
  const amount = ethers.utils.formatUnits(raw, tokenMeta.USDT.decimals)
  if (raw.lt(ethers.utils.parseUnits('0.3', 6))) {
    console.log(`wUSDT balance ${amount} is under the Bridgers minimum (0.3); nothing to swap`)
    return
  }
  console.log(`Swapping ${amount} wUSDT -> native USDT via Bridgers`)
  await runVendor('bridgers-swap.js', [
    'swap',
    '--from', 'celo', '--to', 'celo',
    '--fromToken', 'USDT', '--toToken', 'USDT(Native)',
    '--amount', amount, '--slippage', '0.5',
  ])
  console.log(`Waiting for native USDT to arrive (up to ${SWAP_WAIT_MS / 60000} min)...`)
  const deadline = Date.now() + SWAP_WAIT_MS
  while (Date.now() < deadline) {
    const now = await usdt.balanceOf(wallet.address)
    if (now.gt(before)) {
      console.log(`Received ${ethers.utils.formatUnits(now.sub(before), 6)} native USDT`)
      return
    }
    await new Promise((r) => setTimeout(r, SWAP_POLL_MS))
  }
  throw new Error('swap submitted but native USDT not received within the wait window; re-run sweep later')
}

async function phaseSweep(p, wallet, to) {
  // 1. Revoke the UPDOWN Router allowance (granted once by tools/approve.js).
  const wusdt = new ethers.Contract(tokenMeta.USDT.address, ERC20_ABI, wallet)
  const allowance = await wusdt.allowance(wallet.address, addresses.Router)
  if (!allowance.isZero()) {
    const tx = await wusdt.approve(addresses.Router, 0)
    await tx.wait()
    console.log(`revoked wUSDT allowance for Router: ${tx.hash}`)
  } else {
    console.log('wUSDT allowance for Router already 0')
  }

  // 2. Every ERC-20 balance.
  const b = await balances(p, wallet.address)
  for (const t of b.tokens) {
    if (t.raw.isZero()) continue
    const c = new ethers.Contract(t.address, ERC20_ABI, wallet)
    const tx = await c.transfer(to, t.raw)
    await tx.wait()
    console.log(`sent ${t.human} ${t.symbol} -> ${to}: ${tx.hash}`)
  }

  // 3. Native CELO minus a small reserve for the transfer itself.
  const celo = await p.getBalance(wallet.address)
  const sendable = celo.sub(CELO_GAS_RESERVE)
  if (sendable.gt(0)) {
    const tx = await wallet.sendTransaction({ to, value: sendable })
    await tx.wait()
    console.log(`sent ${ethers.utils.formatEther(sendable)} CELO -> ${to}: ${tx.hash}`)
  }
}

async function main() {
  const phase = arg('phase', 'dry')
  const toArg = arg('to')
  if (!toArg || !ethers.utils.isAddress(toArg)) throw new Error('--to <destination address> is required')
  const to = ethers.utils.getAddress(toArg)
  const p = provider()
  const owner = phase === 'dry' && !process.env.CELO_PRIVATE_KEY
    ? process.env.CELO_WALLET_ADDRESS
    : signer(p).address
  if (!owner) throw new Error('need CELO_WALLET_ADDRESS (dry) or the signing key')

  console.log(`# closeout phase=${phase}`)
  console.log(`wallet:      ${owner}`)
  console.log(`destination: ${to}`)
  printBalances('before', await balances(p, owner))

  if (phase === 'dry') {
    console.log('\n## planned')
    console.log('swap:  wUSDT -> native USDT via Bridgers (same wallet)')
    console.log(`sweep: revoke Router allowance; transfer every non-zero token above and CELO minus ${ethers.utils.formatEther(CELO_GAS_RESERVE)} to ${to}`)
    return
  }
  const wallet = signer(p)
  if (phase === 'swap') await phaseSwap(p, wallet)
  else if (phase === 'sweep') await phaseSweep(p, wallet, to)
  else throw new Error(`unknown phase ${phase}`)
  printBalances('after', await balances(p, owner))
}

main().catch((err) => {
  console.error(`Error: ${err.message}`)
  process.exitCode = 1
})
