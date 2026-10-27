# Closing review — 2026-10-27

The experiment is closed. This is the final accounting, the reasons, and what
the harness proved. Numbers come from `state/trades.ndjson`, `state/state.json`,
the health-report history and the chain.

## 1. Final result

| | Sleeve A (aggressive momentum, ETH+CELO 1h, 3x) | Sleeve B (protective trend, BTC 4h, 1.5x) | Total |
|---|---:|---:|---:|
| Start equity (2026-08-06) | 10.45 | 10.45 | 20.90 |
| Final booked equity | 11.11 (+0.66) | 8.20 (−2.25) | 19.31 (−1.59) |
| Closed trades | 17 (8W / 9L) | 19 (5W / 14L) | 36 (13W / 23L) |
| Booked PnL | +0.68 | −2.25 | −1.57 |
| Profit factor | 1.25 | 0.34 | 0.74 |
| By market | ETH +1.38 (10 trades), CELO −0.70 (7) | BTC −2.25 | |

Neither sleeve's result is distinguishable from zero: live expectancy
−0.04 ± 0.06 USD/trade, t = −0.68 at n = 36. Sleeve A finished slightly
positive and Sleeve B clearly negative, but the honest reading is "noise minus
costs", not "A has edge".

### What the ledger does not show

| | USD |
|---|---:|
| Booked PnL | −1.57 |
| Keeper execution fees never charged to the sleeves (~63 CELO burned over 37 round trips at ~$0.08) | ≈ −5.0 |
| **True trading result** | **≈ −6.6** |

The wallet held 15.55 wUSDT against a booked 19.31: a 3.76 USD gap from
protocol fees, price impact and funding that the ledger models at a flat
20 bp. Measured all-in cost was ~98 bp of notional per round trip.

### Where the money went (by exit type)

| exit | n | net USD | win rate | avg hold |
|---|---:|---:|---:|---:|
| stop-loss | 14 | −3.64 | 0% | 27h |
| time-stop | 10 | +0.01 | 50% | 57h |
| take-profit | 5 | +2.70 | 100% | 33h |
| trend-filter exit | 4 | −1.26 | 25% | 48h |
| unattributed | 3 | +0.62 | 67% | 68h |

Sleeve B's geometry is a structural loser: the stop was hit roughly three
times as often as the target while paying only twice as much when it won.

## 2. Why it stopped

Three independent reasons, any one of which would have been enough.

1. **No edge, offline or live.** The 2026-09-16 review (6.5-month backtest,
   n = 64) measured the gross signal at −7 bp/trade against ~117 bp of
   round-trip cost. Nothing in the live log contradicts that.
2. **The venue stopped filling orders.** The last fill was 2026-10-11. From
   2026-10-13 every entry (26 in a row) sat unexecuted until the bot cancelled
   it; the wallet was the only address sending orders to the UPDOWN
   ExchangeRouter for the rest of October. Gas prices were unchanged (~201 gwei
   before and after), so the keeper, not gas, stopped. Each phantom cycle still
   cost ~0.3 CELO.
3. **The self-improvement loop never ran.** `weekly-review.yml` failed on every
   Monday from 2026-09-21 to 2026-10-26: the backtest history fetcher is
   Binance-only and GitHub runners receive HTTP 451. The live bot survived
   because `src/data/candles.js` falls back to OKX. No tuning was ever applied.

A smaller operational bug compounded (2) and hid it: entries are logged at
submission, and the rollback/cancel paths log nothing, so the performance
report showed "29 positions still open" instead of "26 consecutive unfilled
entries".

## 3. Wind-down

- Kill switch `BOT_ENABLED=false`; `bot`, `health-report`, `weekly-review`
  workflows disabled.
- Platform collateral (wUSDT, an issuer-minted wrapper with no on-chain
  redemption) converted back to native USDT through the Bridgers route while
  it still quoted (fee ~0.10 USDT).
- Router allowance revoked; all balances swept to the funding wallet.
- `CELO_PRIVATE_KEY` secret deleted; repository archived.

Transactions are listed at the end of this file.

## 4. What the harness proved

Worth keeping, independent of this signal:

- **Reconcile-against-chain** every run (fills between runs, re-arming exits,
  cancelling stuck keeper orders) worked for 82 days with zero unprotected
  positions.
- **Gas guard**: never hold a position the CELO balance cannot close.
- **Analytics that argue with themselves**: the perf report's true-cost section
  caught the ledger drift the strategy would otherwise have hidden.
- **Cadence-aware backtest**: GitHub's `*/30` cron delivered ~6.5 runs/day, not
  48; the harness replays at the measured cadence. Polling was *not* the
  problem (refuted a leading hypothesis).
- **Promotion gate** for any self-tuning: OOS n ≥ 20, positive after full
  costs, t ≥ +2 (not |t|), ≥ 15 bp better than incumbent, every cadence seed
  profitable, train/OOS agree in sign. Default outcome is no change.

## 5. Lessons

1. Rank strategies on **basis points of notional per trade**, never net USD:
   with equity-proportional sizing every losing config saturates at the same
   near-ruin number.
2. Fixed fees (1.4 CELO per keeper order) dominate at $15 notional. The bar for
   any future signal at this size is **≥ 1.2% gross per trade**, or a much
   larger account and ≥ 50 bp.
3. **Log the terminal state of every intent**, not just submissions. A
   venue-dead condition should surface as "N consecutive unfilled entries" in
   the health report, and should pause entries automatically.
4. Anything that must run reliably on a schedule must not depend on a single
   data vendor from a GitHub runner's IP.
5. Watch the venue, not just the strategy: a DEX with one active trader has no
   keeper incentive and no exit liquidity for its wrapped collateral.

## 6. Withdrawal transactions

Filled in at close-out; see the `closeout` workflow run summaries.
