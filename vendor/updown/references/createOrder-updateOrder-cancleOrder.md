# createOrder / updateOrder / cancleOrder (cancelOrder) contract reference

This document is based on the contracts implemented in this repo and provides `updown` with a reference for the order lifecycle:

- `createOrder`
- `updateOrder`
- `cancleOrder` (spelling kept to match requirement; the actual contract function is `cancelOrder`)

---

## 1) ExchangeRouter external interface

The core interface of `IExchangeRouter` is:

- `createOrder(IBaseOrderUtils.CreateOrderParams params) returns (bytes32 key)`
- `updateOrder(bytes32 key, uint256 sizeDeltaUsd, uint256 acceptablePrice, uint256 triggerPrice, uint256 minOutputAmount, uint256 validFromTime, bool autoCancel)`
- `cancelOrder(bytes32 key)`

These interfaces are forwarded by `ExchangeRouter` to `OrderHandler`, and account permission checks are performed.

---

## 2) Key logic of createOrder

### 2.1 Call path

`ExchangeRouter.createOrder` -> `OrderHandler.createOrder` -> `OrderUtils.createOrder`

### 2.2 Relationship with multicall (current updown approach)

For `MarketIncrease` (open position), it is recommended to include in the same transaction:

1. `sendWnt(orderVault, executionFee)`
2. `sendTokens(initialCollateralToken, orderVault, initialCollateralDeltaAmount)`
3. `createOrder(params)`

In other words, use a single `ExchangeRouter.multicall([...])` submission to reduce the chance of failure and keep parameters consistent.

### 2.3 Key validation points (from `OrderUtils.createOrder`)

- The order type must be creatable, otherwise `OrderTypeCannotBeCreated`
- Increase / swap types read the actual collateral transferred in via `OrderVault.recordTransferIn(...)`
- Execution fee (WNT) is validated separately; otherwise `InsufficientWntAmountForExecutionFee`
- Position orders validate whether the market is valid
- Market orders do not allow `validFromTime`; otherwise `UnexpectedValidFromTime`
- `swapPath`, receiver, `callbackGasLimit`, etc. are validated
- Finally, the execution fee is estimated and checked against its max, the order is stored, and `OrderCreated` is emitted

### 2.4 createOrder for decreasing positions

For `MarketDecrease / LimitDecrease / StopLossDecrease`:

- `initialCollateralDeltaAmount` is taken directly from the parameter, instead of being auto‑read from transferIn like increase orders.
- Usually you only need `sendWnt + createOrder` (for execution fee), no `sendTokens` required.

---

## 3) Key logic of updateOrder

### 3.1 Permission and updatability

`ExchangeRouter.updateOrder` first checks:

- The order `account` must equal `msg.sender`, otherwise `Unauthorized`

`OrderHandler.updateOrder` then checks:

- Whether the update feature is enabled for this order type
- Market orders cannot be updated; otherwise `OrderNotUpdatable`
- Order type must be supported; otherwise `UnsupportedOrderType`

### 3.2 Fields affected by update

The following fields are updated and written back:

- `sizeDeltaUsd`
- `acceptablePrice`
- `triggerPrice`
- `minOutputAmount`
- `validFromTime`
- `autoCancel`
- And unfreeze the order: `isFrozen = false`

Additionally, WNT can be transferred in to top up the executionFee (common when resuming frozen orders).

---

## 4) Key logic of cancleOrder (cancelOrder)

### 4.1 Entry point

`ExchangeRouter.cancelOrder(bytes32 key)`:

- If the order does not exist, `EmptyOrder`
- Only the order owner can cancel, otherwise `Unauthorized`

### 4.2 Cancel behavior (`OrderHandler.cancelOrder` -> `OrderUtils.cancelOrder`)

- Validate that the cancel feature is enabled
- For market orders, require the minimum cancellable time window (`validateRequestCancellation`)
- Remove the order from `OrderStore`
- For increase/swap orders, refund `initialCollateralDeltaAmount` to `cancellationReceiver` (or back to the account if unset)
- Emit `OrderCancelled` event
- Finally pay out the executionFee according to the rules

---

## 5) Implementation suggestions for updown scripts

### createOrder (open position)

- Keep using `multicall: sendWnt + sendTokens + createOrder`
- `acceptablePrice` can be auto‑computed from on‑chain price by default (long +3%, short ‑3%)
- Before sending the order, run `callStatic.multicall` to pre‑check and decode custom errors

### createOrder (close position)

- First fetch account positions with `Reader.getAccountPositions` and match the target position
- For decrease orders, use `multicall: sendWnt + createOrder`
- Set `orderType` to `MarketDecrease`
- Support `closePercent` (1–100) and convert it to `sizeDeltaUsd`

### update / cancel

- `update-order.js`: take `orderKey` and a JSON config, preserve omitted fields,
  and call `updateOrder(...)`.
- `cancel-order.js`: take `orderKey` and call `cancelOrder(orderKey)`.
- Both run `callStatic` before sending the real transaction and exit non-zero
  on failure.
