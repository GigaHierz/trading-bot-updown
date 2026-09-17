# UPDOWN two-sleeve trading bot (Celo)

Automated perp trading on [UPDOWN](https://github.com/UpDownDex/skills) — a
GMX-v2-style perpetual futures DEX on Celo — driven by a GitHub Actions
schedule. One wallet, two independent $10 strategy sleeves:

| Sleeve | Strategy | Markets | Leverage | Exits | Risk stance |
|---|---|---|---|---|---|
| A | 1h momentum breakout (EMA 8/24 + 24-bar Donchian) | ETH, CELO | 3x | on-exchange TP +6% / SL −2.5%, 48h time-stop | aggressive; losing the $10 is accepted |
| B | 4h trend filter (EMA 20/60, 0.4% dead zone) | BTC | 1.5x | on-exchange TP +3% / SL −1.5%, filter exit | **hard halt at $5 equity** |

**No profit is guaranteed.** UPDOWN's own risk disclosure reports very shallow
market depth; position sizes here are deliberately tiny and the Mento FX
markets are excluded. Treat the whole wallet as money you can lose.

## How it runs

`.github/workflows/bot.yml` ticks every 30 minutes (best-effort). Each run:

1. Loads `state/state.json` (committed back to the repo after every run).
2. Reconciles state against the chain — realizes TP/SL fills that happened
   between runs, re-arms missing exit orders, cancels keeper orders stuck
   longer than 45 minutes.
3. Computes signals from Binance candles (OKX fallback).
4. Applies risk gates (balances, protocol minimums, daily entry caps,
   sleeve-B drawdown halt) and executes at most 8 transactions.

Every entry immediately places **on-exchange** TP and SL orders, so positions
stay protected even if scheduled runs are skipped.

An entry is only allowed when the wallet holds enough CELO to place those
orders **and** to re-arm and close them later (`minCeloForEntry`, derived in
`src/config.js`). If a held position ever becomes unprotectable anyway, the
gas guard closes it while the execution fee is still affordable rather than
leaving it running without a stop.

### Reviewing it

| Command | Answers |
|---|---|
| `node tools/health-report.js` | Is it alive? Liveness, balances, gas runway. Posted twice daily. |
| `node tools/perf-report.js` | What did it earn? Win rate, expectancy ± std err, cost drag. |
| `node tools/weekly-review.js` | What happened? Trading + uptime + a CONTINUE/ADJUST/HALT call. Posted Mondays by `weekly-review.yml`, committed to `reports/weekly/`. |
| `node tools/auto-tune.js` | What should change? Searches, validates out-of-sample, and applies the winner — or stops trading. |
| `node tools/backtest.js` | Would a change have helped? Offline replay at the real polling cadence. |

### The self-improving loop

Every Monday `weekly-review.yml` runs `tools/auto-tune.js --apply`, which
searches the parameter space on a training window, validates the top
candidates **out-of-sample**, and writes `state/tuning.json` — merged into the
live config by `src/config.js` — but only if the promotion gate passes:

| Gate | Why |
|---|---|
| OOS n ≥ 20 | below that the t-statistic means nothing |
| positive **after full costs** | gross edge here is ~−7bp against ~117bp of round-trip cost |
| OOS t ≥ +2 | significantly *positive*, not merely significant |
| ≥ 15bp better than the incumbent | a margin, not a rounding artifact |
| every cadence seed profitable | not just the lucky poll sequence |
| train and OOS agree in sign | otherwise it was picked by the half it was tuned on |

Search on train, validate only the top few on OOS, promote at most one. The
default outcome is **no change** — a search over enough cells always produces
a winner, and almost all of them are noise.

**"Stop trading" is a legal output.** If nothing beats the incumbent *and* the
incumbent is significantly losing out-of-sample, the loop sets
`tradingEnabled: false` on itself. The bot then takes no new entries but still
exits and protects what it holds. It re-enables only on positive OOS evidence,
never just because time passed.

What the loop may **never** touch: the CELO reserve, the risk gates, the
drawdown halt, position minimums. Bounds are in `src/tuning.js`; anything
outside them is rejected rather than clamped, and a config that violates a
structural invariant (`tpPct ≤ slPct`, `emaFast ≥ emaSlow`) reverts that sleeve
entirely. A corrupt `tuning.json` falls back to the hand-written config.

```bash
node tools/auto-tune.js                  # dry run — search and report only
node tools/auto-tune.js --apply          # write state/tuning.json
```

`reports/2026-09-16-strategy-review.md` is the first full review. Its finding:
the signal has no edge and the cost floor is ~117bp per round trip against a
gross edge of −7bp. Read it before funding anything further.

### Backtesting

```bash
node tools/backtest.js --fetch-only --from 2026-03-01   # warm .cache/
node tools/backtest.js --from 2026-03-01 --to 2026-09-15 --offline
node tools/backtest.js --offline --seeds 5 \
  --sweep 'A.slPct=0.025,0.04;A.tpPct=0.03,0.06'
```

The default output compares the strategy at every-bar polling against the
cadence GitHub Actions actually delivers (~6.5 runs/day, measured, versus a
nominal 48). Sweeps rank on basis points of notional per trade, score every
cell across several cadence seeds, and flag cells whose |t| < 2.

### Controls (GitHub → Settings → Secrets and variables → Actions)

| Kind | Name | Meaning |
|---|---|---|
| Variable | `BOT_ENABLED` | Kill switch. Anything but `true` stops runs entirely. |
| Variable | `DRY_RUN` | Set to `false` to trade with real funds. Unset/other = simulation. |
| Secret | `CELO_PRIVATE_KEY` | Wallet key. Never logged; the logger masks 64-hex strings. |
| Secret | `CELO_RPC_URL` | e.g. `https://forno.celo.org` |
| Variable | `CELO_WALLET_ADDRESS` | Wallet address. Lets the reporting workflows read chain state without the signing key. |

## Funding the wallet

The platform's collateral is **wUSDT** (`0xd96a…f595`), not native Celo USDT.

1. Send **$20 native USDT** (Celo, `0x4806…3D5e`) and **~12 CELO** to the
   wallet. The CELO covers keeper execution fees — each order prepays
   ≥1.4 CELO which is refunded on execution or cancel, and an entry keeps
   3 orders in flight.
2. Convert native USDT → wUSDT once (from the repo root, with `.env` filled in):
   ```bash
   node -r dotenv/config vendor/updown/scripts/bridgers-swap.js swap \
     --from celo --to celo --fromToken 'USDT(Native)' --toToken USDT \
     --amount 20 --slippage 0.5
   ```
3. Grant the one-time trading allowance: `node tools/approve.js`

## Go-live checklist

1. `npm ci && npm test`
2. Local dry runs: `node src/index.js` (repeat a few times; watch `state/`).
3. Set `BOT_ENABLED=true`, leave `DRY_RUN` unset → watch a day of scheduled
   dry runs in the Actions tab.
4. Fund the wallet (above), add the real `CELO_PRIVATE_KEY` secret.
5. Run the smoke test: Actions → bot → Run workflow → `smoke: true`.
   It does a $10 1x CELO round trip: open → keeper fill → TP/SL place →
   cancel → market close. Verify on Celoscan.
6. Set `DRY_RUN=false`. Watch the first 48h; flip `BOT_ENABLED` to stop.

## Local development

```bash
cp .env.example .env   # fill in the key for live commands; not needed for dry runs
npm ci
npm test
node src/index.js      # dry run by default
```

State lives in `state/state.json` + `state/trades.ndjson` (append-only trade
log). To reset the experiment, restore both to their initial contents while no
positions are open. Sleeve B's halt flag is intentionally manual to reset:
`sleeves.B.halted` in `state/state.json`.

`vendor/updown/` is a pinned copy of the official UpDown skill scripts — see
`vendor/updown/VENDOR.md`. The bot never reimplements order encoding; it
shells out to those scripts (`src/exchange/updown.js`).
