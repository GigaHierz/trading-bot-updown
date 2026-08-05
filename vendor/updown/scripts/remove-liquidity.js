/**
 * Remove liquidity (Withdrawal) — approve WNT and market tokens first, then use multicall to send sendTokens + createWithdrawal
 *
 * Usage: node scripts/remove-liquidity.js <config.json>
 * See assets/orders/remove-liquidity-example.json, and configure WithdrawalVault and WNT in addresses.json
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({
  path: path.resolve(__dirname, "../assets/celo.env.local"),
});

const addresses = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/addresses.json"), "utf8")
);
const exchangeRouterAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/abis/ExchangeRouter.json"), "utf8")
).abi;
const erc20Abi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/abis/ERC20.json"), "utf8")
).abi;
const errorsAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/abis/Errors.json"), "utf8")
).abi;
const dataStoreAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/abis/DataStore.json"), "utf8")
).abi;
const tokenMeta = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/celo-tokens.json"), "utf8")
);
const markets = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/markets.json"), "utf8")
);
const {
  ensureAllowance,
  findMarket,
  resolveExecutionFee,
} = require("./lib/protocol");

function decodeRevertReason(error) {
  const data =
    error?.error?.data ||
    error?.data ||
    error?.error?.error?.data ||
    error?.receipt?.revertReason;
  if (!data || typeof data !== "string") return "Unknown revert reason";
  try {
    const iface = new ethers.utils.Interface(errorsAbi);
    const parsed = iface.parseError(data);
    return `${parsed.name}(${parsed.args.map((x) => x.toString()).join(", ")})`;
  } catch {}
  if (data.startsWith("0x08c379a0")) {
    try {
      return ethers.utils.defaultAbiCoder.decode(["string"], "0x" + data.slice(10))[0];
    } catch {
      return "Reverted (string decode failed)";
    }
  }
  return "Reverted (no string reason)";
}

function readConfig(configPath) {
  const fullPath = path.resolve(process.cwd(), configPath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

function toUnits(value, decimals) {
  if (value === undefined || value === null) return undefined;
  return ethers.utils.parseUnits(String(value), decimals).toString();
}

function normalizeAddr(addr) {
  return (addr || "").toLowerCase();
}

function findMarketBySymbol(symbol) {
  return findMarket(markets, symbol);
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("Usage: node scripts/remove-liquidity.js <config.json>");
    console.error("Example: node scripts/remove-liquidity.js assets/orders/remove-liquidity-btc.json");
    process.exitCode = 1;
    return;
  }

  const cfg = readConfig(configPath);
  const rpcUrl = process.env.CELO_RPC_URL;
  const privateKey = process.env.CELO_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    throw new Error("Missing CELO_RPC_URL or CELO_PRIVATE_KEY in assets/celo.env.local");
  }

  const celo = addresses.celo || addresses;
  const withdrawalVault = cfg.withdrawalVault || celo.WithdrawalVault;
  const wntAddress = cfg.wnt || celo.WNT;
  const routerAddress = celo.Router;

  if (!withdrawalVault || !ethers.utils.isAddress(withdrawalVault)) {
    throw new Error(
      "Missing or invalid WithdrawalVault. Set addresses.celo.WithdrawalVault or config.withdrawalVault"
    );
  }
  if (!wntAddress || !ethers.utils.isAddress(wntAddress)) {
    throw new Error(
      "Missing or invalid WNT/fee token. Set addresses.celo.WNT or config.wnt"
    );
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || "42220"),
    name: "celo",
  });
  const dataStore = new ethers.Contract(celo.DataStore, dataStoreAbi, provider);
  const wallet = new ethers.Wallet(privateKey, provider);
  const account = cfg.receiver || wallet.address;

  const exchangeRouter = new ethers.Contract(
    celo.ExchangeRouter,
    exchangeRouterAbi,
    wallet
  );

  let marketAddress = cfg.market;
  if (!marketAddress && (cfg.marketSymbol || cfg.market)) {
    const m = findMarketBySymbol(cfg.marketSymbol || cfg.market);
    if (!m) throw new Error("Market not found: " + (cfg.marketSymbol || cfg.market));
    marketAddress = m.marketToken;
  }

  if (!marketAddress) {
    throw new Error("Config must provide market or marketSymbol");
  }

  const marketTokenAmount =
    cfg.marketTokenAmount ??
    toUnits(cfg.marketTokenAmountHuman ?? 0, 18);
  const executionFee = await resolveExecutionFee({
    cfg,
    dataStore,
    provider,
    gasLimitKey: "WITHDRAWAL_GAS_LIMIT",
    oraclePriceCount: 3,
    callbackGasLimit: cfg.callbackGasLimit || 0,
  });

  if (!marketTokenAmount || ethers.BigNumber.from(marketTokenAmount).isZero()) {
    throw new Error("Missing marketTokenAmount or marketTokenAmountHuman");
  }
  if (!executionFee) {
    throw new Error("Missing executionFee or executionFeeHuman");
  }

  console.log("\n=== UPDOWN Remove Liquidity ===\n");
  console.log("market (LP token):", marketAddress);
  console.log("marketTokenAmount:", ethers.utils.formatEther(marketTokenAmount));
  console.log("executionFee:", ethers.utils.formatEther(executionFee));
  console.log("withdrawalVault:", withdrawalVault);
  console.log("receiver:", account);

  const wntContract = new ethers.Contract(wntAddress, erc20Abi, wallet);
  const marketTokenContract = new ethers.Contract(marketAddress, erc20Abi, wallet);

  const maxUint = ethers.constants.MaxUint256;

  const [wntBalance, marketBalance, wntAllowance, marketAllowance] = await Promise.all([
    wntContract.balanceOf(account),
    marketTokenContract.balanceOf(account),
    wntContract.allowance(account, routerAddress),
    marketTokenContract.allowance(account, routerAddress),
  ]);

  console.log("\nBalances / Allowances:");
  console.log("  WNT balance:", ethers.utils.formatEther(wntBalance));
  console.log("  Market token balance:", ethers.utils.formatEther(marketBalance));

  if (wntBalance.lt(executionFee)) {
    throw new Error("Insufficient WNT/fee balance, required " + ethers.utils.formatEther(executionFee));
  }
  if (marketBalance.lt(marketTokenAmount)) {
    throw new Error("Insufficient market token balance, required " + ethers.utils.formatEther(marketTokenAmount));
  }

  if (wntAllowance.lt(executionFee)) {
    console.log("Approving WNT to Router...");
    await ensureAllowance({
      token: wntContract,
      owner: account,
      spender: routerAddress,
      required: executionFee,
      approveAmount: maxUint,
    });
    console.log("  WNT approved");
  }
  if (marketAllowance.lt(marketTokenAmount)) {
    console.log("Approving market token to Router...");
    await ensureAllowance({
      token: marketTokenContract,
      owner: account,
      spender: routerAddress,
      required: marketTokenAmount,
      approveAmount: maxUint,
    });
    console.log("  Market token approved");
  }

  const withdrawalParams = {
    receiver: account,
    callbackContract: ethers.constants.AddressZero,
    uiFeeReceiver: ethers.constants.AddressZero,
    market: marketAddress,
    longTokenSwapPath: [],
    shortTokenSwapPath: [],
    minLongTokenAmount: 0,
    minShortTokenAmount: 0,
    shouldUnwrapNativeToken: false,
    executionFee,
    callbackGasLimit: 0,
  };

  const multicallArgs = [
    exchangeRouter.interface.encodeFunctionData("sendTokens", [
      wntAddress,
      withdrawalVault,
      executionFee,
    ]),
    exchangeRouter.interface.encodeFunctionData("sendTokens", [
      marketAddress,
      withdrawalVault,
      marketTokenAmount,
    ]),
    exchangeRouter.interface.encodeFunctionData("createWithdrawal", [withdrawalParams]),
  ];

  console.log("\nSending withdrawal transaction (multicall)...");

  try {
    await exchangeRouter.callStatic.multicall(multicallArgs, {
      gasLimit: 2500000,
    });
  } catch (err) {
    console.error("callStatic pre-check failed:", decodeRevertReason(err));
    throw err;
  }

  const tx = await exchangeRouter.multicall(multicallArgs, {
    gasLimit: 2500000,
  });

  console.log("txHash:", tx.hash);
  console.log("Explorer: https://celoscan.io/tx/" + tx.hash);

  const receipt = await tx.wait();
  console.log("Block:", receipt.blockNumber, "gasUsed:", receipt.gasUsed.toString());

  const withdrawalCreatedTopic = ethers.utils.id(
    "WithdrawalCreated(bytes32,address,address,address,address,address[],address[],uint256,uint256,uint256,bool,uint256,uint256,uint256,bool,uint256,uint256)"
  );
  for (const log of receipt.logs) {
    if (log.topics[0] === withdrawalCreatedTopic) {
      console.log("WithdrawalCreated key:", log.topics[1]);
      break;
    }
  }

  console.log("\nWithdrawal request submitted, waiting for keeper execution.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
