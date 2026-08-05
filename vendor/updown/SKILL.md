---
name: updown
description: Trade and manage UPDOWN perpetuals on Celo. Use for market, limit, stop-loss, take-profit, and TWAP orders; position, balance, and pending-order queries; order cancellation; liquidity deposits or withdrawals; Bridgers funding routes; and UPDOWN market configuration.
---

# UPDOWN on Celo

Operate the scripts from this skill directory. Treat every address, amount, side,
price, and order type as a typed field: never infer a missing money-moving field.

## Safety contract

- Fail closed on ambiguous, conditional, multi-leg, negative, or incomplete intent.
- Never print, copy, return, serialize, or transmit `CELO_PRIVATE_KEY`.
- Resolve assets by contract address. Same-symbol assets with different addresses
  are different tokens.
- Use `assets/addresses.json`, `assets/markets.json`, and
  `assets/celo-tokens.json` as local sources of truth. Match symbols
  case-insensitively and preserve their canonical spelling.
- Omit `executionFee` by default. Execution scripts derive a buffered minimum
  from current on-chain gas configuration. Reject an explicit fee below it.
- Before a live transaction, state the action, market, side, amount or percentage,
  trigger/acceptable price when applicable, receiver, and estimated execution fee.
  If the current request did not explicitly authorize submission, stop for
  confirmation.
- A submitted request is not an executed trade. Report the transaction receipt,
  order key when available, and keeper-pending state separately.
- Reporting is opt-in. Do not set `TRADE_REPORT_API_URL` or
  `TRADE_SETUP_API_URL` unless the user asks to enable telemetry.

Read [references/risk-disclosure.md](references/risk-disclosure.md) before the
first money-moving action for a user. Include the relevant risk in the preview.

## 1. Establish readiness

Run:

```bash
npm ci
node scripts/check-setup.js --no-report
node scripts/query.js balance
```

If setup fails, read [references/setup.md](references/setup.md). Do not ask the
user to paste a private key into chat. This step is complete only when the wallet
address, RPC connection, native CELO balance, native USDT balance, and UPDOWN
wrapped-token balances are visible.

## 2. Classify one action

Choose exactly one:

- Read: balances, positions, markets, or pending orders
- Create: market, limit, stop-market, stop-loss, take-profit, or TWAP
- Manage: close a position, update a pending order, or cancel a pending order
- Liquidity: add or remove
- Funding: Bridgers quote or swap

For free text, generate a config with the strict parser:

```bash
node scripts/trade-assistant.js "<one instruction>"
```

The parser must reject unsupported intent instead of narrowing it silently.
For non-USDT collateral, unusual swaps, or advanced parameters, create a
structured JSON config from a CLI template rather than forcing free text:

```bash
node scripts/trade-cli.js order-types
node scripts/trade-cli.js template <OrderType>
```

This step is complete only when one action, one market, one side, and every
required numeric input are explicit.

## 3. Inspect current state

Run the relevant read before generating a mutation:

```bash
node scripts/query.js positions
node scripts/query.js orders
node scripts/trade-cli.js markets
```

For close, stop-loss, and take-profit, match the actual open position by market
and side. Do not guess `initialCollateralToken`; omit it unless the user selected
a specific collateral position. The execution script uses the matched
position's collateral address.

This step is complete only when the intended position or pending order is
uniquely identified. If several positions match, require a collateral token or
other disambiguator.

## 4. Validate the preview

Check the generated JSON:

- `market`, `indexToken`, and token addresses exist in local assets.
- `isLong`, order type, size, collateral, and `closePercent` match the request.
- Limit and protective orders contain both `triggerPriceHuman` and
  `acceptablePriceHuman`.
- `closePercent` is greater than 0 and at most 100.
- Leverage and notional stay within configured caps.
- TWAP uses 2–20 parts. “Over N minutes” is total duration; the last part must
  be scheduled at the end of that duration.
- No secret or reporting credential appears in the config.

This step is complete only when every check passes and the preview contains no
unresolved field.

## 5. Submit and verify

Run exactly one matching command:

```bash
node scripts/open-position.js orders/<config>.json
node scripts/close-position.js orders/<config>.json
node scripts/send-twap-multicall.js "<order-file pattern>"
node scripts/update-order.js <order-key> <update-config.json>
node scripts/cancel-order.js <order-key>
```

The scripts preflight contract calls, confirm and re-read ERC-20 allowance after
approval, submit, and exit non-zero on failure. Never describe a failed or
missing receipt as success.

This step is complete only when the receipt has `status = 1`; for order creation,
also report the order key or explain that it could not be decoded and query
pending orders.

## Read operations

```bash
node scripts/query.js balance
node scripts/query.js positions
node scripts/query.js orders
node scripts/trade-cli.js markets
```

Read operations do not require transaction confirmation and make no telemetry
request unless reporting was explicitly configured.

## Liquidity branch

Read
[references/liquidity-deposit-withdrawal.md](references/liquidity-deposit-withdrawal.md)
before using:

```bash
node scripts/add-liquidity.js <config.json>
node scripts/remove-liquidity.js <config.json>
```

Keeper execution is asynchronous. Completion means the request receipt succeeds
and the resulting balances are verified after keeper execution.

## Bridgers funding branch

Read [references/omni-bridgers.md](references/omni-bridgers.md) before using:

```bash
node scripts/bridgers-swap.js quote ...
node scripts/bridgers-swap.js swap ...
```

`USDT(Native)` and UPDOWN `USDT` are distinct Celo contracts. For every request,
verify `fromTokenAddress != toTokenAddress`, include `sourceType: "H5"`,
`sourceFlag: "perpex01"`, and use the wallet address as `equipmentNo`. After a
mined swap, upload its hash through `updateDataAndStatus`; otherwise treat the
route as incomplete.

## References

- Environment: [references/setup.md](references/setup.md)
- Orders and cancellation:
  [references/createOrder-updateOrder-cancleOrder.md](references/createOrder-updateOrder-cancleOrder.md)
- Liquidity:
  [references/liquidity-deposit-withdrawal.md](references/liquidity-deposit-withdrawal.md)
- Bridgers: [references/omni-bridgers.md](references/omni-bridgers.md)
- Market refresh:
  [references/markets-update-guide.md](references/markets-update-guide.md)
- Risk: [references/risk-disclosure.md](references/risk-disclosure.md)
