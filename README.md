# RIFT ATM × MagicBlock Ephemeral Rollups

Sub-50ms on-chain BUY flow via MagicBlock ER delegation, integrated into the live RIFT ATM (mainnet, Solana).

**Frontier 2026 — Privacy Track** (MagicBlock co-sponsored with SNS and STMY).

---

## What this is

RIFT is a fiat-to-crypto ATM running on Solana mainnet. Each customer BUY triggers an on-chain claim cycle: `lock_buy_claim` → swap (Jupiter/LI.FI/Umbra) → `confirm_dispensed`. On bare mainnet, these account mutations take 400-800ms each, slowing the BUY UX visibly for the customer waiting at the kiosk.

MagicBlock Ephemeral Rollups let us delegate the operator + claim PDAs to a MagicBlock ER validator for the duration of the swap, dropping per-tx latency to <50ms. The final state is committed back to mainnet at the end of the BUY.

## Architecture
┌─────────────────┐
│  Customer BUYS  │
│  €X cash at ATM │
└────────┬────────┘
│
▼
┌─────────────────────────────┐
│ 1. lock_buy_claim (mainnet) │  ← Claim PDA created
└────────┬────────────────────┘
│
▼
┌─────────────────────────────────────┐
│ 2. openSessionViaProgram (Anchor)   │  ← Delegate Operator + Claim PDAs
│    → delegate_session CPI           │     to MagicBlock ER validator
└────────┬────────────────────────────┘
│
▼
┌─────────────────────────────────────┐
│ 3. Swap on ER (sub-50ms)            │  ← Mutations happen on ER,
│    Jupiter / LI.FI / Umbra          │     not mainnet
└────────┬────────────────────────────┘
│
▼
┌─────────────────────────────────────┐
│ 4. confirm_dispensed (ER)           │  ← Settles claim on ER
└────────┬────────────────────────────┘
│
▼
┌─────────────────────────────────────┐
│ 5. commitAndCloseViaProgram         │  ← commit_and_undelegate_session
│    → commit final state to mainnet  │
└─────────────────────────────────────┘

## Repository layout
rift-magicblock/
├── integration/
│   └── magicblock.js              ← Production module (8 exports)
├── scripts/
│   └── enable_privacy_mode.js     ← Companion one-shot script
├── README.md                       ← This file
├── WIRING.md                       ← How it wires into atm-connector BUY flow
└── PROOFS.md                       ← Production deployment evidence

## Module exports (`integration/magicblock.js`)

| Function | Purpose |
|---|---|
| `openSession` | Delegate keypair-owned accounts to ER (non-PDA path) |
| `openSessionViaProgram` | Delegate via Anchor program CPI (PDA-safe path) — **used by RIFT** |
| `commitAndClose` | Commit final ER state back to mainnet (non-PDA) |
| `commitAndCloseViaProgram` | Commit via Anchor program CPI — **used by RIFT** |
| `delegateIx` | Standalone delegation instruction builder |
| `commitAndUndelegateIx` | Standalone commit instruction builder |
| `erConnection` | Construct Connection object to ER endpoint |
| `liveSessions` | Inspect currently-live ER sessions for debugging |

## Failure modes (fail-safe by design)

If the MagicBlock SDK is unavailable, the ER endpoint is down, or any delegation step fails:

- `magicblock.js` catches the error and returns null/throws to the caller
- `atm-connector.js` wraps every MagicBlock call in `try/catch`
- The BUY automatically falls back to mainnet-only execution
- The customer receives crypto either way — MagicBlock is a performance layer, not a critical path

See WIRING.md for the exact fail-safe code paths in the BUY flow.

## Feature gate

MagicBlock activation is controlled by a single environment variable:

```bash
USE_MAGICBLOCK=1                                              # enable
MAGICBLOCK_ER_ENDPOINT=https://eu.magicblock.app              # default EU endpoint
```

With `USE_MAGICBLOCK=0` (default), the integration is fully inert: no ER program is built at boot, no delegation occurs, no MagicBlock code path executes.

## Production status

| Item | State |
|---|---|
| Module installed | ✅ `@magicblock-labs/ephemeral-rollups-sdk@0.10.5` |
| Module integrated | ✅ atm-connector.js lines 627 (boot), 1024 (open), 1273 (commit) |
| Feature gate wired | ✅ `USE_MAGICBLOCK=1` |
| Anchor CPI path | ✅ `delegate_session` + `commit_and_undelegate_session` on Rift program |
| Mainnet endpoint | ✅ `https://eu.magicblock.app` |
| Fail-safe fallback | ✅ try/catch around every ER call, mainnet path unaffected |

## License

MIT — Yann Mapouka <yamap@riftatm.com>
