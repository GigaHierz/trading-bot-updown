# Strategy review — 2026-09-16

Covers the live run from 2026-08-06 to 2026-09-16, plus a 6.5-month offline
replay. The conclusion is not a tuning recommendation.

---

## 1. What the live run actually produced

12 clean live round trips (a 13th opened in simulation and closed live, so it
is excluded). 4 wins / 8 losses, 33% win rate, **net −$1.83** booked on a
$20.90 seed.

The booked figure understates the loss. Sleeve equity charges only the 20bp
protocol fee; it never charges the CELO execution fee. Roughly 1.3 CELO is
consumed per round trip — 15.6 CELO ≈ $1.25 — so the real result is
**−$3.08, about 94bp of notional per trade against the 20bp modelled.**

`node tools/perf-report.js` reproduces all of this.

### The sample is too small to conclude anything from

Expectancy −$0.15 ± $0.12 per trade, **t = −1.32 at n=12**. That is
indistinguishable from zero. Nothing in the live log justifies a parameter
change — which is why the weekly review refuses to recommend one below 30
closed trades.

### The bot was blocked for most of its life

Of 81 health reports since 2026-08-07, **9 said `ALL GOOD`**. 72 reported CELO
below the entry gate. **40 were below the exit gate too**, meaning the bot
could not place, re-arm or cancel a stop.

The largest single loss came directly from that. On 2026-08-14 a BTC short
opened at 62870 with a stop at 63813. CELO fell to 0.90 that evening and
stayed there for five days — below both gates. The stop could not be
maintained, price ran to 68511 (a 9% adverse move, ~6x past the stop), and the
position was finally closed by a *strategy* exit, not by the stop.
**−$1.10 = 59% of all losses booked.**

Fixed: the entry gate now reserves the gas needed to protect and close what it
opens, and `gasGuard()` closes positions that become unprotectable while the
fee is still affordable.

---

## 2. What the backtest says

6.5 months of ETH/CELO 1h and BTC 4h bars, replayed through the real strategy
functions at realistic polling cadences. `node tools/backtest.js`.

### Polling cadence is not the problem

The leading hypothesis going in was that a 1h breakout strategy polled ~6.5
times a day never sees its own signals. It is wrong.

| cadence | runs/day | trades | win rate | net USD | expectancy |
|---|---:|---:|---:|---:|---:|
| every bar (unreachable) | 24 | 69 | 27.5% | −12.01 | −0.174 ±0.040 (t=−4.35) |
| nominal cron (*/30) | 48 | 70 | 27.1% | −11.94 | −0.171 ±0.040 (t=−4.24) |
| measured Aug (17/day) | 17.7 | 64 | 26.0% | −11.87 | −0.187 ±0.038 (t=−4.88) |
| measured now (6.5/day) | 6.5 | 64 | 24.6% | −11.90 | −0.191 ±0.039 (t=−4.88) |

**The cadence gap is $0.11 over 6.5 months.** Looking more often does not
help, because the strategy re-evaluates on whatever the newest closed bar is;
a missed breakout is not a delayed trade, it is simply a trade that never
happens — and those trades were not the profitable ones.

Two consequences: adding a signal-lookback window would buy nothing, and the
staleness gate at `src/index.js:137` is near-dead code (it fires 0 times,
because `refPrice` is always the freshest closed bar).

### At n≈64 the edge is significantly negative

t ≈ −4.9. Unlike the live sample, this is not noise. Over 6.5 months both
sleeves reach ruin: sleeve A grinds down to its $6 minimum notional, and
sleeve B trips its 50% drawdown halt. The protective halt works as designed.

The exit mix shows why: **39 stop-losses for −$14.48 against 12 take-profits
for +$3.67.** The stop is hit 3.25x as often as the target while paying only
2.4x as much when it wins (6% / 2.5%). That is a losing combination by
construction.

### No TP/SL geometry rescues it

Ranked on basis points of notional per trade — net USD saturates, because a
losing configuration shrinks its own position sizes and every variant lands
near the same ruin.

| params | trades | win rate | edge bps/trade | Δ bps |
|---|---:|---:|---:|---:|
| _baseline (6% / 2.5%)_ | 64 | 24.6% | −180.7 | — |
| sl 2.5% / tp 10% | 65 | 23.3% | −178.3 | +2.4 |
| sl 2.5% / tp 3% | 60 | 30.1% | −184.8 | −4.1 |
| sl 4% / tp 3% | 58 | 34.5% | −197.7 | −17.0 |
| sl 6% / tp 3% | 53 | 34.3% | −222.5 | −41.8 |
| sl 6% / tp 6% | 49 | 25.3% | −240.8 | −60.1 |

Every cell is deeply negative. The best is within noise of the baseline.

### Where the money actually goes

Same strategy, costs peeled back one layer at a time:

| costs applied | trades | net USD | edge bps/trade |
|---|---:|---:|---:|
| none (gross signal) | 240 | −1.57 | **−7.4** |
| + 20bp protocol fee | 231 | −6.12 | −23.5 |
| + 30bp slippage | 147 | −11.81 | −78.6 |
| + 1.3 CELO execution fee | 64 | −11.90 | −180.7 |

**The raw signal is a coin flip** — −7.4bp per trade, essentially zero. There
is no alpha to protect, but there is no disaster either. What kills the
account is cost: roughly 117bp per round trip against a gross edge of −7bp.
Breaking even would need a gross edge above 1.2% per trade.

The CELO execution fee is the largest component precisely because it is
*fixed* (~$0.10) while the edge scales with notional. At $15 notional that is
67bp. It is a position-size problem as much as a fee problem.

### Trading bigger does not fix it either

| equity per sleeve | trades | return | edge bps/trade |
|---|---:|---:|---:|
| $10.45 (today) | 64 | −57% | −180.7 |
| $50 | 171 | −71% | −106.0 |
| $100 | 200 | −71% | −93.6 |
| $500 | 206 | −69% | −84.1 |

Size amortises the gas (−181 → −84bp) but cannot outrun the ~50bp
fee-plus-slippage floor on a signal with no edge. Returns get *worse* with
size, because the bot survives longer and trades more.

---

## 3. Conclusion

This is not a parameter-tuning problem, a polling problem, or a gas problem.
**The momentum-breakout and EMA-trend signals have no edge on these markets at
these timeframes, and the cost structure is far too heavy for the position
sizes involved.** Tuning TP/SL, extending the time stop, or adding a signal
lookback would all be fitting noise.

Three honest options:

1. **Stop.** Flatten via `tools/flatten.js`, set `BOT_ENABLED=false`, and keep
   the ~$19. The infrastructure — gas guard, analytics, backtest harness,
   weekly review — remains and is reusable for any future signal.
2. **Keep running as a paid experiment.** The gas guard and drawdown halt now
   bound the damage. Expect to lose the remaining balance slowly; the value is
   operational learning, not return.
3. **Replace the signal, not the parameters.** Use the backtest harness to
   test candidate signals offline *before* funding them. The bar to clear is
   concrete and now measurable: **a gross edge above ~1.2% per trade at $15
   notional**, or a much larger account plus a gross edge above ~50bp.

The measurement to run before any future strategy goes live is the cost
decomposition table above. If a candidate cannot clear its own cost floor
offline, it will not clear it with real money.
