# UPDOWN risk disclosure

Read this before the first money-moving action for a user and whenever the
market, funding route, or protocol configuration may have changed.

## Transaction model

- Order, deposit, and withdrawal transactions create asynchronous requests.
  Off-chain keepers must later execute them.
- Execution fees are prepaid. A successful request receipt does not guarantee
  immediate execution.
- Limit and protective orders can remain pending and lock their execution fee.
  List them with `node scripts/query.js orders` and cancel with
  `node scripts/cancel-order.js <order-key>`.

## Asset model

- UPDOWN wrapped tokens are contract-defined assets, not interchangeable with
  same-symbol native or bridged tokens.
- Wrapped collateral may be mintable, burnable, or pausable by its controller.
  Do not describe it as trustless or reserve-backed without current evidence.
- A Bridgers route may require sending assets to an externally controlled
  address before receiving the target token. That introduces counterparty,
  inventory, timing, and non-atomic settlement risk. Describe it as a routed
  transfer, not a guaranteed atomic swap.

## Governance and operations

The 2026-07-29 evaluation observed concentrated administration, a small keeper
set, and administrator-controlled wrapped collateral. Treat these as current
facts only after an on-chain recheck; otherwise present them as dated
observations.

## Liquidity

Liquidity can be extremely shallow and can change quickly. The same evaluation
observed roughly USD 26–28 in AUDm and GBPm markets and roughly USD 1,463 in the
CELO/USDT market. Never reuse those figures as current liquidity. Check current
market state before any material trade and warn that price impact, execution,
and withdrawal availability depend on live liquidity.

## User-facing minimum disclosure

Before submission, state:

1. This creates an asynchronous keeper-executed request.
2. The execution fee is prepaid and any excess refund follows protocol rules.
3. The selected token contract address and whether it is native, bridged, or an
   UPDOWN wrapped token.
4. Any known counterparty, administration, keeper, or liquidity risk relevant
   to the action.
