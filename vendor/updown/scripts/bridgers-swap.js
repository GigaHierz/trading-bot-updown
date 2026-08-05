const fs = require('fs')
const path = require('path')
const { ethers } = require('ethers')
require('dotenv').config({
  path: path.resolve(__dirname, '../assets/celo.env.local'),
  quiet: true,
})

// Bridgers API base URL
const BRIDGERS_API_BASE = 'https://api.bridgers.xyz'

// Bridgers contract addresses
const BRIDGERS_ADDRESSES = {
  arbitrum: '0xb685760ebd368a891f27ae547391f4e2a289895b',
  celo: '0xd1088d3376c2384d469d1c0d55d503695e1be3e6',
}

// Chain name mapping
const CHAIN_NAMES = {
  ethereum: 'ETH',
  bsc: 'BSC',
  arbitrum: 'ARBITRUM',
  celo: 'CELO',
  polygon: 'MATIC',
  base: 'BASE',
}

// Load tokens for chain from JSON config
function loadTokensForChain(chainName) {
  const tokensPath = path.join(__dirname, '../assets/omni-bridgers-tokens.json')
  const omniTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'))

  // Derive chainId for this chain via omni-bridgers-rpc config
  const rpcConfigPath = path.join(__dirname, '../assets/omni-bridgers-rpc.json')
  const rpcConfigs = JSON.parse(fs.readFileSync(rpcConfigPath, 'utf8'))

  const chainKey = chainName.toLowerCase()
  if (!CHAIN_NAMES[chainKey]) {
    throw new Error(`Unsupported chain: ${chainName}`)
  }

  const targetMainNetwork = CHAIN_NAMES[chainKey]
  const chainId = Object.keys(rpcConfigs).find(
    (id) => rpcConfigs[id].mainNetwork === targetMainNetwork,
  )

  console.log(`\n[loadTokensForChain] Load chain: ${chainName}`)
  console.log(
    `[loadTokensForChain] mainNetwork = ${targetMainNetwork}, chainId = ${chainId}`,
  )

  const result = {}

  if (chainId && omniTokens[chainId]) {
    console.log(
      `[loadTokensForChain] Read ${omniTokens[chainId].length} tokens from omni-bridgers-tokens.json`,
    )
    for (const token of omniTokens[chainId]) {
      const symbolKey = token.symbol
      if (!symbolKey) continue
      result[symbolKey.toUpperCase()] = {
        address: token.address,
        symbol: symbolKey,
        decimals: token.decimals,
      }
    }
  }

  // For Celo, additionally merge updown's celo-tokens.json
  if (chainKey === 'celo') {
    const celoTokensPath = path.join(__dirname, '../assets/celo-tokens.json')
    const celoTokens = JSON.parse(fs.readFileSync(celoTokensPath, 'utf8'))
    console.log(
      `[loadTokensForChain] Celo merging extra tokens from celo-tokens.json: ${
        Object.keys(celoTokens).length
      } tokens`,
    )
    for (const [symbol, info] of Object.entries(celoTokens)) {
      const symbolKey = symbol
      result[symbolKey.toUpperCase()] = {
        address: info.address,
        symbol: symbolKey,
        decimals: info.decimals,
      }
    }
  }

  console.log(
    `[loadTokensForChain] Final tokens for chain (${chainName}): ${Object.keys(
      result,
    ).join(', ')}`,
  )

  return result
}

// Find token from specific config
function findTokenFromConfig(chainName, symbol, configType) {
  const chainKey = chainName.toLowerCase()

  if (configType === 'celo-tokens') {
    // Find from celo-tokens.json
    const celoTokensPath = path.join(__dirname, '../assets/celo-tokens.json')
    const celoTokens = JSON.parse(fs.readFileSync(celoTokensPath, 'utf8'))
    const token = celoTokens[symbol]
    if (token) {
      return {
        address: token.address,
        symbol: symbol,
        decimals: token.decimals,
      }
    }
  } else if (configType === 'omni-bridgers') {
    // Find from omni-bridgers-tokens.json
    const tokensPath = path.join(
      __dirname,
      '../assets/omni-bridgers-tokens.json',
    )
    const omniTokens = JSON.parse(fs.readFileSync(tokensPath, 'utf8'))

    const rpcConfigPath = path.join(
      __dirname,
      '../assets/omni-bridgers-rpc.json',
    )
    const rpcConfigs = JSON.parse(fs.readFileSync(rpcConfigPath, 'utf8'))

    const targetMainNetwork = CHAIN_NAMES[chainKey]
    const chainId = Object.keys(rpcConfigs).find(
      (id) => rpcConfigs[id].mainNetwork === targetMainNetwork,
    )

    if (chainId && omniTokens[chainId]) {
      const token = omniTokens[chainId].find(
        (t) => t.symbol === symbol || t.baseSymbol === symbol,
      )
      if (token) {
        return {
          address: token.address,
          symbol: token.symbol,
          decimals: token.decimals,
        }
      }
    }
  }

  return null
}

// Load chain config
function loadChainConfig(chainName) {
  const rpcConfigPath = path.join(__dirname, '../assets/omni-bridgers-rpc.json')
  const rpcConfigs = JSON.parse(fs.readFileSync(rpcConfigPath, 'utf8'))

  const chainKey = Object.keys(CHAIN_NAMES).find(
    (key) => key === chainName.toLowerCase(),
  )
  if (!chainKey) {
    throw new Error(`Unsupported chain: ${chainName}`)
  }

  const chainId = Object.keys(rpcConfigs).find((key) => {
    return rpcConfigs[key].mainNetwork === CHAIN_NAMES[chainKey]
  })

  if (!chainId) {
    throw new Error(`No chain config found for: ${chainName}`)
  }

  return rpcConfigs[chainId]
}

// Get provider and wallet for a chain
function getProviderAndWallet(chainName, privateKey) {
  const config = loadChainConfig(chainName)
  const rpcUrl = config.rpcUrls[0]
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
  let wallet
  if (privateKey) {
    wallet = new ethers.Wallet(privateKey, provider)
  }
  return { provider, wallet, config }
}

// Build full URL
function buildUrl(base, path) {
  return base.replace(/\/$/, '') + path
}

async function postBridgers(pathname, params) {
  const response = await fetch(
    buildUrl(BRIDGERS_API_BASE, pathname),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    },
  )
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`Bridgers returned invalid JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    throw new Error(
      `Bridgers HTTP ${response.status}: ${
        body?.resMsg || body?.message || text.slice(0, 200)
      }`,
    )
  }
  return body
}

// Get quote (fetchQuote)
async function fetchQuote(params) {
  return postBridgers('/api/sswap/quote', params)
}

// Get swap calldata (fetchSwapCall)
async function fetchSwapCall(params) {
  return postBridgers('/api/sswap/swap', params)
}

// Upload transaction hash to Bridgers (updateDataAndStatus)
async function updateDataAndStatus(params) {
  return postBridgers(
    '/api/exchangeRecord/updateDataAndStatus',
    params,
  )
}

// Query transaction history (fetchTransData)
async function fetchTransData(account) {
  const response = await fetch(
    buildUrl(
      BRIDGERS_API_BASE,
      '/api/exchangeRecord/getTransData?userAddr=' + account,
    ),
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
  return response.json()
}

// Main function
async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    console.log(`\n=== Bridgers Cross-chain Swap (multi-chain support) ===

Usage:
  node scripts/bridgers-swap.js <command> [options]

Commands:
  quote      Get swap quote
  swap       Execute swap

Celo USDT (Two tokens on the same chain):
  - USDT:  bridged USDT used as Updown USDT or wUSDT for updown trading system.
    Address: 0xd96a1ac57a180a3819633bCE3dC602Bd8972f595
  - USDT(Native): Celo-native USDT.
    Address: 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e
  Use the correct symbol or address when quoting or swapping so the route matches the token you intend.

Examples:
  # 1. Cross-chain: Arbitrum USDT -> Celo platform USDT (Arbitrum USDT -> Celo USDT)
   ## Get quote (Arbitrum USDT -> Celo USDT)
  node scripts/bridgers-swap.js quote \\
    --from arbitrum \\
    --to celo \\
    --fromToken USDT \\
    --toToken USDT \\
    --amount 5

  ## Execute swap
  node scripts/bridgers-swap.js swap \\
    --from arbitrum \\
    --to celo \\
    --fromToken USDT \\
    --toToken USDT \\
    --amount 5 \\
    --slippage 0.5

  # 2. Same chain on Celo: native USDT -> platform USDT (Celo USDT(Native) -> Celo USDT)
   ## Get quote (Celo USDT(Native) -> Celo USDT)
  node scripts/bridgers-swap.js quote \\
    --from celo \\
    --to celo \\
    --fromToken 'USDT(Native)' \\
    --toToken USDT \\
    --amount 5

   ## Execute swap
  node scripts/bridgers-swap.js swap \\
    --from celo \\
    --to celo \\
    --fromToken 'USDT(Native)' \\
    --toToken USDT \\
    --amount 5 \\
    --slippage 0.5

Supported chains: ethereum, bsc, arbitrum, celo, polygon, base
Swap signing key: set BRIDGERS_PRIVATE_KEY in assets/celo.env.local.
For quote-only requests without a local key, pass --walletAddress 0x...
`)
    return
  }

  // Parse parameters
  const params = {}
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace('--', '')
    const value = args[i + 1]
    params[key] = value
  }

  const fromChain = params.from
  const toChain = params.to
  const fromToken = params.fromToken
  const toToken = params.toToken
  const amount = params.amount
  if (params.privateKey) {
    throw new Error(
      'Do not pass private keys on the command line; set BRIDGERS_PRIVATE_KEY in assets/celo.env.local',
    )
  }
  const privateKey =
    process.env.BRIDGERS_PRIVATE_KEY || process.env.CELO_PRIVATE_KEY
  const slippage = parseFloat(params.slippage || '0.5')

  if (!fromChain || !toChain || !fromToken || !toToken || !amount) {
    throw new Error(
      'Please provide: --from, --to, --fromToken, --toToken, --amount',
    )
  }

  if (!privateKey && command === 'swap') {
    throw new Error(
      'Swap requires BRIDGERS_PRIVATE_KEY in assets/celo.env.local',
    )
  }

  console.log(`\n=== Bridgers Cross-chain Swap ===`)
  console.log(`From chain: ${fromChain}`)
  console.log(`To chain:   ${toChain}`)
  console.log(`From token: ${fromToken}`)
  console.log(`To token:   ${toToken}`)
  console.log(`Amount:     ${amount}`)

  try {
    // Get source-chain config and wallet
    const { provider, wallet, config } = getProviderAndWallet(
      fromChain,
      privateKey,
    )
    const walletAddress = wallet?.address || params.walletAddress
    if (!walletAddress || !ethers.utils.isAddress(walletAddress)) {
      throw new Error(
        'A real wallet is required: configure BRIDGERS_PRIVATE_KEY or pass --walletAddress for quote',
      )
    }
    console.log(`\n✅ Using ${fromChain} chain config`)
    console.log(`📋 Wallet address: ${walletAddress}`)
    console.log(`🔗 RPC:            ${config.rpcUrls[0]}`)

    // Load token info from JSON config
    let fromTokenInfo, toTokenInfo

    // Check if specific config requested
    if (params.fromTokenConfig) {
      // Load source token from specific config
      fromTokenInfo = findTokenFromConfig(
        fromChain,
        fromToken,
        params.fromTokenConfig,
      )
      console.log(
        `\n[Token config] from ${params.fromTokenConfig} loaded ${fromToken}: ${
          fromTokenInfo?.address || 'not found'
        }`,
      )
    } else {
      const fromTokens = loadTokensForChain(fromChain)
      fromTokenInfo = fromTokens[fromToken.toUpperCase()]
    }

    if (params.toTokenConfig) {
      // Load target token from specific config
      toTokenInfo = findTokenFromConfig(toChain, toToken, params.toTokenConfig)
      console.log(
        `[Token config] from ${params.toTokenConfig} loaded ${toToken}: ${
          toTokenInfo?.address || 'not found'
        }`,
      )
    } else {
      const toTokens = loadTokensForChain(toChain)
      toTokenInfo = toTokens[toToken.toUpperCase()]
    }

    if (!fromTokenInfo) {
      throw new Error(`Unsupported source token: ${fromToken} on ${fromChain}`)
    }

    console.log(`\n📤 From address: ${walletAddress}`)
    console.log(`📥 To address:   ${walletAddress}`)
    console.log(
      `   ⚠️  Cross-chain transfer will send funds to this address, please double-check!`,
    )

    // Build quote params
    const fromTokenAmountRaw = ethers.utils
      .parseUnits(amount, fromTokenInfo.decimals)
      .toString()

    const quoteParams = {
      equipmentNo: walletAddress,
      sourceType: 'H5',
      userNo: '',
      sessionUuid: '',
      orderId: '',
      sourceFlag: 'perpex01',
      utmSource: '',
      fromTokenAddress: fromTokenInfo.address,
      toTokenAddress: toTokenInfo?.address,
      fromTokenAmount: fromTokenAmountRaw,
      fromTokenChain: CHAIN_NAMES[fromChain.toLowerCase()],
      toTokenChain: CHAIN_NAMES[toChain.toLowerCase()],
      userAddr: walletAddress,
      source: '',
    }
    if (!toTokenInfo) {
      throw new Error(`Unsupported destination token: ${toToken} on ${toChain}`)
    }
    if (
      fromTokenInfo.address.toLowerCase() === toTokenInfo.address.toLowerCase()
    ) {
      throw new Error(
        'Source and destination token addresses are identical; check token symbol mapping',
      )
    }

    console.log('\nRequest params (fetchQuote):')
    console.log(JSON.stringify(quoteParams, null, 2))
    console.log('')

    let quoteResult
    try {
      quoteResult = await fetchQuote(quoteParams)
      console.log('\n=== Full API response ===\n')
      console.log(JSON.stringify(quoteResult, null, 2))
      console.log('\n=== Parsed quote result ===\n')

      if (
        quoteResult.resCode === 100 &&
        quoteResult.data &&
        quoteResult.data.txData
      ) {
        const txData = quoteResult.data.txData

        console.log('✅ Quote fetched successfully!\n')
        console.log('📊 Basic info:')
        console.log('  resCode:', quoteResult.resCode)
        console.log('  resMsg: ', quoteResult.resMsg)
        console.log('')

        console.log('💱 Token info:')
        console.log(
          '  From token address:',
          txData.fromTokenAddress || fromTokenInfo.address,
        )
        console.log(
          '  From token amount:',
          ethers.utils.formatUnits(
            txData.fromTokenAmount,
            txData.fromTokenDecimal,
          ),
          fromTokenInfo.symbol,
        )
        console.log('  From token decimals:', txData.fromTokenDecimal)
        console.log(
          '  To token address:',
          txData.toTokenAddress || toTokenInfo?.address,
        )
        console.log(
          '  To token amount:',
          txData.toTokenAmount,
          toTokenInfo?.symbol || fromTokenInfo.symbol,
        )
        console.log('  To token decimals:', txData.toTokenDecimal)
        console.log('')

        console.log('💰 Fee info:')
        console.log('  Rate:', txData.instantRate)
        console.log('  Fee rate:', txData.fee * 100, '%')
        console.log(
          '  Fee amount:',
          (
            parseFloat(
              ethers.utils.formatUnits(
                txData.fromTokenAmount,
                txData.fromTokenDecimal,
              ),
            ) * txData.fee
          ).toFixed(6),
          fromTokenInfo.symbol,
        )
        console.log('  On-chain fee:', txData.chainFee, fromTokenInfo.symbol)
        console.log(
          '  Total fee:',
          (
            parseFloat(txData.chainFee) +
            parseFloat(
              ethers.utils.formatUnits(
                txData.fromTokenAmount,
                txData.fromTokenDecimal,
              ),
            ) *
              txData.fee
          ).toFixed(6),
          fromTokenInfo.symbol,
        )
        console.log('')

        console.log('⏱️  Limits:')
        console.log('  Estimated time:', txData.estimatedTime, 'minutes')
        console.log('  Min deposit:', txData.depositMin, fromTokenInfo.symbol)
        console.log('  Max deposit:', txData.depositMax, fromTokenInfo.symbol)
        console.log(
          '  Min output:',
          ethers.utils.formatUnits(txData.amountOutMin, txData.toTokenDecimal),
          toTokenInfo?.symbol || fromTokenInfo.symbol,
        )
        console.log('')

        console.log('🔧 Technical info:')
        console.log('  DEX:', txData.dex)
        console.log('  Contract address:', txData.contractAddress)
        console.log('  Logo:', txData.logoUrl)
        console.log('  Route:', txData.path || '[]')
        console.log('')

        console.log('💡 Tips:')
        console.log(
          '  Actual received amount may vary due to market volatility',
        )
        console.log(
          '  Ensure enough balance for amount and on-chain fees on source chain',
        )
        console.log(
          '  Suggested approve amount:',
          ethers.utils.formatUnits(
            txData.fromTokenAmount,
            txData.fromTokenDecimal,
          ),
          fromTokenInfo.symbol,
        )
        console.log('')
      } else {
        console.log('❌ Quote failed:')
        console.log('  resCode:', quoteResult.resCode)
        console.log('  resMsg: ', quoteResult.resMsg)
        throw new Error('Quote failed: ' + quoteResult.resMsg)
      }
    } catch (e) {
      console.error('❌ Error while fetching quote:', e.message)
      if (command === 'swap') throw e
      return
    }

    if (command === 'quote') {
      return
    }

    // Execute swap
    console.log(`\n=== Executing swap ===`)

    // Check and approve allowances
    const bridgersAddress = BRIDGERS_ADDRESSES[fromChain.toLowerCase()]
    if (!bridgersAddress) {
      throw new Error(`Unsupported source chain: ${fromChain}`)
    }

    const erc20Abi = [
      'function approve(address spender, uint256 amount) returns (bool)',
      'function allowance(address owner, address spender) view returns (uint256)',
    ]

    const tokenContract = new ethers.Contract(
      fromTokenInfo.address,
      erc20Abi,
      wallet,
    )
    const allowance = await tokenContract.allowance(
      wallet.address,
      bridgersAddress,
    )
    const requiredAmount = ethers.utils.parseUnits(
      amount,
      fromTokenInfo.decimals,
    )

    if (allowance.lt(requiredAmount)) {
      console.log(`\n🔐 Approving Bridgers contract to spend ${fromToken}...`)
      const approveTx = await tokenContract.approve(
        bridgersAddress,
        requiredAmount.mul(2),
      )
      await approveTx.wait()
      console.log(`✅ Approve successful: ${approveTx.hash}`)
    } else {
      console.log(`\n✅ Existing allowance is sufficient`)
    }

    // Get swap calldata
    const amountOutMin = ethers.utils
      .parseUnits(
        (
          parseFloat(quoteResult.data.txData.toTokenAmount) *
          (1 - slippage / 100)
        ).toFixed(6),
        toTokenInfo?.decimals || fromTokenInfo.decimals,
      )
      .toString()

    const swapParams = {
      ...quoteParams,
      fromAddress: walletAddress,
      toAddress: walletAddress,
      amountOutMin: amountOutMin,
      fromCoinCode: fromTokenInfo.symbol,
      toCoinCode: toTokenInfo?.symbol || fromTokenInfo.symbol,
    }

    console.log(`\nRequest params (fetchSwapCall):`)
    console.log(JSON.stringify(swapParams, null, 2))
    console.log(`\nFetching swap calldata...`)
    const swapResult = await fetchSwapCall(swapParams)

    console.log(`\n=== fetchSwapCall response ===`)
    console.log(JSON.stringify(swapResult, null, 2))

    if (swapResult.resCode !== 100) {
      throw new Error(`Failed to get swap calldata: ${swapResult.resMsg}`)
    }

    const txData = swapResult.data.txData.data
    const txTo = swapResult.data.txData.to
    const txValue = swapResult.data.txData.value || '0x0'

    console.log(`\n📤 Transaction info:`)
    console.log(`   Target contract: ${txTo}`)
    console.log(`   Value:          ${txValue}`)

    // Send transaction
    console.log(`\n🚀 Sending transaction...`)
    const tx = await wallet.sendTransaction({
      to: txTo,
      data: txData,
      value: txValue === '0x0' ? 0 : ethers.BigNumber.from(txValue),
    })

    console.log(`\n✅ Transaction submitted!`)
    console.log(`   txHash: ${tx.hash}`)
    console.log(`   Explorer: ${config.blockExplorerUrl}/tx/${tx.hash}`)

    console.log(`\n⏳ Waiting for confirmation...`)
    const receipt = await tx.wait()
    if (receipt.status !== 1) throw new Error('Source-chain transaction failed')
    console.log(`\n✅ Transaction confirmed!`)
    console.log(`   Block: ${receipt.blockNumber}`)
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`)

    console.log(`\n🎉 Cross-chain swap submitted!`)
    console.log(
      `   Estimated arrival time: ${quoteResult.data.txData.estimatedTime} minutes`,
    )
    console.log(`   Please check your balance on the destination chain`)

    // Upload txHash
    const updateParams = {
      hash: tx.hash,
      fromTokenAddress: swapParams.fromTokenAddress,
      toTokenAddress: swapParams.toTokenAddress,
      fromAddress: swapParams.fromAddress,
      toAddress: swapParams.toAddress,
      fromTokenChain: swapParams.fromTokenChain,
      toTokenChain: swapParams.toTokenChain,
      fromTokenAmount: swapParams.fromTokenAmount,
      amountOutMin: swapParams.amountOutMin,
      fromCoinCode: swapParams.fromCoinCode,
      toCoinCode: swapParams.toCoinCode,
      sourceFlag: 'perpex01',
    }

    console.log(
      `\n➡️ Uploading tx hash to Bridgers backend... (updateDataAndStatus)`,
    )
    try {
      const updateResult = await updateDataAndStatus(updateParams)
      if (updateResult.resCode === 100) {
        console.log(`✅ Tx hash successfully synced to Bridgers backend!`)
      } else {
        throw new Error(`Tx hash sync failed: ${updateResult.resMsg}`)
      }
    } catch (e) {
      throw new Error(`updateDataAndStatus failed: ${e.message}`)
    }
  } catch (error) {
    console.error(`\n❌ Error:`, error.message)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
