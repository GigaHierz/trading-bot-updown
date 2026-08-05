# Add/Remove Liquidity | Liquidity Deposit & Withdrawal

This document describes the full flow, configuration, and contract call logic for `add-liquidity` and `remove-liquidity` in the updown skill.

---

## Overview

- **Add liquidity (Deposit)**: deposit long and short tokens to receive market tokens (LP tokens)
- **Remove liquidity (Withdrawal)**: burn market tokens to receive long and short tokens back

Both require an off‑chain Keeper to execute; the user only submits a request. The flow matches the contract design: **approve first, then use multicall**.

---

## Prerequisites

### 1. addresses.json

Configure the following under `celo` in `assets/addresses.json`:

```json
{
  "celo": {
    "ExchangeRouter": "0x...",
    "Router": "0x...",
    "DepositVault": "0x...",
    "WithdrawalVault": "0x...",
    "WNT": "0x471EcE3750Da237f93B8E339c536989b8978a438"
  }
}
```

| Field           | Description                                                                  |
|-----------------|------------------------------------------------------------------------------|
| DepositVault    | Deposit vault contract address (from deployment)                            |
| WithdrawalVault | Withdrawal vault contract address (from deployment)                         |
| WNT             | Execution‑fee token address, usually the wrapped native token on Celo       |

`DepositVault` and `WithdrawalVault` should be taken from the deployment results of updown‑synthetics (for example, `getContract('DepositVault')`, `getContract('WithdrawalVault')` in the perContract project).

---

## Add liquidity (add-liquidity)

### Flow

1. Approve WNT, long token, and short token to `Router`
2. Call `ExchangeRouter.multicall` with, in order:
   - `sendTokens(WNT, DepositVault, executionFee)` – execution fee
   - `sendTokens(longToken, DepositVault, longAmount)` – long token
   - `sendTokens(shortToken, DepositVault, shortAmount)` – short token
   - `createDeposit(params)` – create deposit request

3. Keeper executes the deposit, and the user receives market tokens (LP tokens)

### Config parameters

| Param                        | Required | Description                                                                |
|-----------------------------|----------|----------------------------------------------------------------------------|
| market                      | yes*     | Market address; can also use `marketSymbol` and resolve from `markets.json` |
| marketSymbol                | yes*     | Market symbol, e.g. `"BTC"`, `"ETH"`                                      |
| initialLongToken            | no       | Long token address; auto‑resolved when using `marketSymbol`               |
| initialShortToken           | no       | Short token address; auto‑resolved when using `marketSymbol`              |
| initialLongTokenAmountHuman | yes      | Long token amount (human readable)                                        |
| initialShortTokenAmountHuman| yes      | Short token amount (human readable)                                       |
| executionFeeHuman           | no       | Optional override; must meet the current on-chain buffered minimum         |
| receiver                    | no       | Address to receive market tokens, defaults to current wallet              |

*At least one of `market` or `marketSymbol` must be provided.

### Config example

```json
{
  "marketSymbol": "BTC",
  "initialLongTokenAmountHuman": 0.001,
  "initialShortTokenAmountHuman": 10,
  "receiver": ""
}
```

### CreateDepositParams structure

The contract parameters for `createDeposit`:

```javascript
{
  receiver,                    // Address receiving the market tokens
  callbackContract: Zero,      // Callback contract
  uiFeeReceiver: Zero,         // UI fee receiver
  market,                      // Market address (market token address)
  initialLongToken,            // Long token address
  initialShortToken,           // Short token address
  longTokenSwapPath: [],       // Swap path (usually empty)
  shortTokenSwapPath: [],      // Swap path
  minMarketTokens: 0,          // Minimum acceptable market tokens (slippage protection)
  shouldUnwrapNativeToken: false,
  executionFee,
  callbackGasLimit: 0
}
```

---

## Remove liquidity (remove-liquidity)

### Flow

1. Approve WNT and market tokens (LP tokens) to `Router`
2. Call `ExchangeRouter.multicall` with, in order:
   - `sendTokens(WNT, WithdrawalVault, executionFee)` – execution fee
   - `sendTokens(marketToken, WithdrawalVault, marketTokenAmount)` – market tokens
   - `createWithdrawal(params)` – create withdrawal request

3. Keeper executes the withdrawal, and the user receives long and short tokens

### Config parameters

| Param                 | Required | Description                                                |
|----------------------|----------|------------------------------------------------------------|
| market               | yes*     | Market token (LP) address                                  |
| marketSymbol         | yes*     | Market symbol, auto‑resolved to market address            |
| marketTokenAmountHuman | yes    | Market token amount to redeem (human readable)            |
| executionFeeHuman    | no       | Optional override; must meet the current on-chain buffered minimum |
| receiver             | no       | Address to receive long/short tokens, defaults to wallet  |

*At least one of `market` or `marketSymbol` must be provided.

### Config example

```json
{
  "marketSymbol": "BTC",
  "marketTokenAmountHuman": 0.1,
  "receiver": ""
}
```

### CreateWithdrawalParams structure

The contract parameters for `createWithdrawal`:

```javascript
{
  receiver,                    // Address receiving long/short tokens
  callbackContract: Zero,
  uiFeeReceiver: Zero,
  market,                      // Market token address
  longTokenSwapPath: [],
  shortTokenSwapPath: [],
  minLongTokenAmount: 0,       // Minimum acceptable long amount (slippage protection)
  minShortTokenAmount: 0,      // Minimum acceptable short amount
  shouldUnwrapNativeToken: false,
  executionFee,
  callbackGasLimit: 0
}
```

---

## FAQ

### 1. DepositVault / WithdrawalVault not configured

Error: `Missing or invalid DepositVault` or `Missing or invalid WithdrawalVault`.

**Fix**: Fill in the correct vault addresses in `addresses.json`. You can obtain them from the perContract deployment scripts or deployment records.

### 2. Approval failed

Make sure WNT, long, short, or market tokens are approved for the `Router` address. The script will auto‑check and send `approve` when necessary; users must ensure they have enough gas.

After an approval is mined, the script re-reads allowance before it submits the
liquidity request. If the updated allowance is not visible, it exits non-zero.

### 3. Insufficient balance

- Add liquidity: must have enough long tokens, short tokens, and WNT (execution fee)
- Remove liquidity: must have enough market tokens and WNT (execution fee)

### 4. Keeper not executing

After a deposit/withdrawal request is submitted, it must wait for the off‑chain Keeper to execute. Funds arrive only after execution completes. You can inspect on‑chain events or Keeper monitoring status.

---

## References

- Contracts: https://github.com/updown-io/updown-synthetics
- Orders: [createOrder-updateOrder-cancleOrder.md](createOrder-updateOrder-cancleOrder.md)
