const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
require("dotenv").config({
  path: path.resolve(__dirname, "../assets/celo.env.local"),
});

const addresses = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/addresses.json"), "utf8")
);
const dataStoreAbi = [
  "function getUint(bytes32 key) view returns (uint256)",
  "function getAddressValuesAt(bytes32 key, uint256 start, uint256 end) view returns (address[])",
  "function getAddressArray(bytes32 key, uint256 start, uint256 end) view returns (address[])"
];
const readerAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../assets/abis/Reader.json"), "utf8")
).abi;
const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

function keyOfString(value) {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["string"], [value])
  );
}

async function main() {
  const rpcUrl = process.env.CELO_RPC_URL;
  if (!rpcUrl) {
    throw new Error("Missing CELO_RPC_URL in assets/celo.env.local");
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, {
    chainId: Number(process.env.CELO_CHAIN_ID || "42220"),
    name: "celo",
  });

  const dataStore = new ethers.Contract(addresses.celo.DataStore, dataStoreAbi, provider);
  const reader = new ethers.Contract(addresses.celo.Reader, readerAbi, provider);

  console.log("\n=== Read markets from chain ===\n");

  try {
    // Try several possible key encodings
    const possibleKeys = [
      keyOfString("MARKET_COUNT"),
      keyOfString("marketCount"),
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes("MARKET_COUNT")),
    ];
    
    let marketCount = ethers.BigNumber.from(0);
    for (const key of possibleKeys) {
      try {
        const count = await dataStore.getUint(key);
        if (count.gt(0)) {
          marketCount = count;
          console.log(`Found market-count key: ${key}`);
          break;
        }
      } catch {}
    }
    
    console.log(`Total markets: ${marketCount.toString()}`);
    console.log("");

    if (marketCount.eq(0)) {
      console.log("No markets on chain (falling back to config file)");
      throw new Error("No markets on chain");
    }

    // Fetch all market addresses
    const marketsKey = keyOfString("MARKET_LIST");
    let marketAddresses = [];
    
    try {
      marketAddresses = await dataStore.getAddressValuesAt(marketsKey, 0, marketCount);
    } catch {
      try {
        marketAddresses = await dataStore.getAddressArray(marketsKey, 0, marketCount);
      } catch {}
    }

    console.log(`Fetched ${marketAddresses.length} markets:\n`);

    // Iterate through each market and fetch detailed info
    for (let i = 0; i < marketAddresses.length; i++) {
      const marketAddress = marketAddresses[i];
      
      try {
        // Use Reader to get market info
        const marketInfo = await reader.getMarket(addresses.celo.DataStore, marketAddress);
        
        // Fetch token symbols
        const indexToken = new ethers.Contract(marketInfo.indexToken, erc20Abi, provider);
        const longToken = new ethers.Contract(marketInfo.longToken, erc20Abi, provider);
        const shortToken = new ethers.Contract(marketInfo.shortToken, erc20Abi, provider);
        
        const [indexSymbol, longSymbol, shortSymbol] = await Promise.all([
          indexToken.symbol().catch(() => "UNKNOWN"),
          longToken.symbol().catch(() => "UNKNOWN"),
          shortToken.symbol().catch(() => "UNKNOWN")
        ]);

        console.log(`${i + 1}. ${indexSymbol}/USDT`);
        console.log(`   Market Token: ${marketAddress}`);
        console.log(`   Index Token: ${indexSymbol} (${marketInfo.indexToken})`);
        console.log(`   Long Collateral: ${longSymbol} (${marketInfo.longToken})`);
        console.log(`   Short Collateral: ${shortSymbol} (${marketInfo.shortToken})`);
        console.log("");

      } catch (err) {
        console.log(`${i + 1}. Market ${marketAddress}`);
        console.log(`   Failed to read details: ${err.message}`);
        console.log("");
      }
    }

  } catch (err) {
    console.error("Failed to read markets from chain:", err.message);
    
    // If on-chain read fails, fall back to local config file
    console.log("\n=== Fallback to config file ===\n");
    const markets = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../assets/markets.json"), "utf8")
    );
    
    markets.forEach((m, i) => {
      console.log(`${i + 1}. ${m.indexTokenSymbol}/USDT`);
      console.log(`   Market Token: ${m.marketToken}`);
      console.log(`   Index Token: ${m.indexTokenSymbol} (${m.indexToken})`);
      console.log(`   Long Collateral: ${m.longTokenSymbol} (${m.longToken})`);
      console.log(`   Short Collateral: ${m.shortTokenSymbol} (${m.shortToken})`);
      console.log("");
    });
  }
}

main().catch(console.error);
