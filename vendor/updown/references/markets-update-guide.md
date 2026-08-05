# Market list update guide

## Current approach

Currently, `markets.json` is a static config file and contains the following markets:

1. BTC/USDT
2. ETH/USDT
3. CELO/USDT
4. EURm/USDT
5. JPYm/USDT
6. NGNm/USDT
7. AUDm/USDT
8. GBPm/USDT

## Problem

If the contracts on the backend add or remove markets, the config file may become inaccurate.

## Solutions

### Option 1: Manually update the config file (recommended)

When you need to update the market list, run:

```bash
node scripts/update-markets.js
```

The script will:
1. Read the latest market list from the chain
2. Update the `assets/markets.json` file
3. Back up the old config file

### Option 2: Read directly from chain (in development)

An experimental script `markets-onchain.js` is provided to try reading the market list in real‑time from the chain:

```bash
node scripts/markets-onchain.js
```

**Note**: This script requires full DataStore ABI support and may not work correctly yet.

### Option 3: Use the Reader contract

If UPDOWN provides a Reader contract with `getMarkets`, you can use:

```javascript
const markets = await reader.getMarkets(dataStoreAddress, 0, 100);
```

## Recommendations

1. **Check regularly**: run `update-markets.js` at least once a week to check for market updates.
2. **Verify before big trades**: for large trades, first query the actual on‑chain market info.
3. **Follow announcements**: watch official UPDOWN announcements for new market listings.

## Related scripts

- `scripts/trade-cli.js markets` – show the markets from the current config file
- `scripts/markets-onchain.js` – try reading the market list from chain (experimental)
- `scripts/update-markets.js` – update the config file
