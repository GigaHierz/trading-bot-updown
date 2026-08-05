# Omni Bridgers related config files (Chains, Tokens & API)

## Updown wrap tokens and cross-chain funding

Trading on the **Updown** platform uses the system’s **wrap tokens** on Celo as collateral and settlement assets (for example wrapped USDT, BTC, ETH, and other markets). Those tokens are **not** arbitrary user-chosen ERC-20s: you must use the addresses and decimals the platform defines.

- **Source of truth**: [`assets/celo-tokens.json`](../assets/celo-tokens.json) lists each market’s wrap token (`symbol`, contract `address`, `decimals`, and a short `description` of how it is used on Updown).
- **Getting wrap tokens**: Users often start with assets on **other chains**.
  Bridgers-compatible routes can return a transfer or deposit instruction that
  is settled by an external operator. Do not assume the route is atomic. Verify
  the quote's sender, receiver, expected output, timeout, and status mechanism,
  and disclose counterparty and inventory risk before funds move.

## Omni Bridgers swap

To make it easy to reuse the chain and token information needed by the frontend `bridgersFetcher` in pure script environments, this repo adds Omni Bridgers related config files under `assets/`. They can serve as the single source of truth for backend or ops scripts:

- `assets/omni-bridgers-tokens.json`

  - Structure matches the usual `bridgersTokens` / `getDefaultBridgerTokens()` config in frontend projects:
  - Top‑level is an object grouped by `chainId`, for example:
  - `"42220"`: CELO
  - `"56"`: BSC
  - `"1"`: Ethereum
  - `"42161"`: Arbitrum
  - `"8453"`: Base
  - Each chain entry is an array of tokens with fields:
  - `name` / `symbol` / `decimals`
  - `address` (ERC‑20 address or `0xeeee...` placeholder for native token)
  - `baseSymbol`: used for Bridgers `fromCoinCode` / `toCoinCode`
  - `chainId`: numeric chain ID
  - `mainNetwork`: chain identifier string (e.g. `"CELO"`, `"ETH"`, `"BSC"`), mapped to `fromTokenChain` / `toTokenChain`

- `assets/omni-bridgers-rpc.json`

  - Stores RPC and explorer info for Omni Bridgers related chains, grouped by `chainId`:
  - `42220`: CELO
  - `56`: BSC
  - `1`: Ethereum
  - `42161`: Arbitrum
  - `8453`: Base
  - Each chain entry has:
  - `chainId` / `mainNetwork` / `symbol`
  - `rpcUrls`: list of public RPC endpoints (can be replaced with private or keyed RPCs)
  - `blockExplorerUrl`: base URL of the block explorer
  - In backend scripts, you can:
  - Read this file and pick an `rpcUrl` based on `fromTokenChain` / `toTokenChain`;
  - Or initialize `ethers.JsonRpcProvider` dynamically from `chainId`.

- `assets/omni-bridgers-api.json`
  - Describes REST call info for Bridgers and the Perpex Token Service:
  - `bridgers` section:
  - `baseUrl`: `"https://api.bridgers.xyz"`
  - `quotePath`: `"/api/sswap/quote"` (used by `bridgersFetcher.fetchQuote`)
  - `swapPath`: `"/api/sswap/swap"` (used by `bridgersFetcher.fetchSwapCall`)
  - `historyListPath`: `"/api/exchangeRecord/getTransData"`
  - `historyDetailPath`: `"/api/exchangeRecord/getTransDataById"`
  - `updateStatusPath`: `"/api/exchangeRecord/updateDataAndStatus"`
  - `requiresApiKey`: currently `false`, meaning **no API key is needed by default**;
  - `headers`: default HTTP headers (currently just `Content-Type: application/json`).
  - `defaultParams`: default fixed request params (such as `sourceType: "H5"`, `sourceFlag: "perpex01"`, etc.) that you can merge in your scripts before sending requests.
  - `perpexTokenService` section:
  - Corresponds to the `https://api.perpex.ai/coin/find` call used in `fetchBridgerTokens`:
  - `baseUrl`: `"https://api.perpex.ai"`
  - `path`: `"/coin/find"`
  - `bodyTemplate`: `{"env": "celo wrap"}` (can be switched based on environment);
  - `requiresApiKey`: currently `false`; for future private deployments, you can extend this with `apiKey` fields, etc.

With these three config files, your scripts can:

1. Based on chain ID / chain identifier, read token info supported by Bridgers from `omni-bridgers-tokens.json` (address, decimals, `mainNetwork`, etc.) and fill `fromTokenAddress` / `toTokenAddress`, `fromCoinCode` / `toCoinCode`.
2. Based on `fromTokenChain` / `toTokenChain`, select an appropriate RPC endpoint from `omni-bridgers-rpc.json` and initialize a Provider.
3. Read Bridgers / Perpex API config from `omni-bridgers-api.json`, merge common params and headers as needed, and send `quote` / `swap` / history / token‑list requests.

## Required request invariants

- Resolve tokens by address, not display name.
- Confirm `fromTokenAddress` and `toTokenAddress` differ.
- Send `sourceType: "H5"` and `sourceFlag: "perpex01"`.
- Set `equipmentNo` to the user's wallet address.
- After the transaction is mined, send its hash to
  `/api/exchangeRecord/updateDataAndStatus`.
- Treat a missing status update, missing destination receipt, or swallowed API
  error as failure.
