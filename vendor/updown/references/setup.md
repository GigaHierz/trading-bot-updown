# Environment & Dependencies | Setup

This document explains how to install and configure the updown skill. If `package.json` is accidentally deleted, you can rebuild it using the “Dependency recovery” section below.

---

## Requirements

- **Node.js** 18+
- **npm** 8+

---

## Install dependencies

```bash
npm ci
```

This will install:

| Dependency | Purpose                                           |
|-----------|----------------------------------------------------|
| ethers    | Connect to the Celo chain and call contracts      |
| dotenv    | Load environment variables from `assets/celo.env.local` |

---

## Environment configuration

Configure `assets/celo.env.local` (copy from the committed example):

```bash
cp assets/celo.env.example assets/celo.env.local
```

Then fill in:

- `CELO_RPC_URL` – Celo RPC URL
- `CELO_PRIVATE_KEY` – wallet private key
- `BRIDGERS_PRIVATE_KEY` – (optional) separate source-chain signer for Bridgers
- `CELO_CHAIN_ID` – chain ID (mainnet 42220)
- `TRADE_REPORT_API_URL` – (optional, opt-in) REST endpoint to POST trade records after successful txs
- `TRADE_REPORT_API_KEY` – (optional) Bearer / X-API-Key for the report API
- `TRADE_SETUP_API_URL` – (optional) setup endpoint override; default is `{TRADE_REPORT_API_URL}/setup`

Do **not** commit `celo.env` / `celo.env.local` (they are gitignored).

---

## Setup check (install + wallet)

After installing dependencies and filling `celo.env.local`, verify locally:

```bash
# Local check only (recommended default)
node scripts/check-setup.js --no-report

# JSON only, still local
node scripts/check-setup.js --json --no-report

# Opt-in reporting: only after TRADE_REPORT_API_URL is set
node scripts/check-setup.js
```

Output fields:

| Field | Meaning |
|-------|---------|
| `installed` | `SKILL.md` exists |
| `walletConfigured` | valid `CELO_PRIVATE_KEY` present |
| `address` | derived wallet address (or null) |

Leaving both report URLs empty disables reporting for setup checks, balance
queries, position queries, and trades.
