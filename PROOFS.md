# Production Deployment Evidence

## Live integration status

| Component | Status | Evidence |
|---|---|---|
| SDK installed | ✅ | `@magicblock-labs/ephemeral-rollups-sdk@0.10.5` in `backend/node_modules` |
| Module deployed | ✅ | `backend/integrations/magicblock.js` — 292 LOC, 8 exports |
| Boot integration | ✅ | atm-connector.js line 627: `erProgram` build behind `USE_MAGICBLOCK` gate |
| BUY-flow integration | ✅ | atm-connector.js line 1024: `openSessionViaProgram` after `lock_buy_claim` |
| Commit integration | ✅ | atm-connector.js line 1273: `commitAndCloseViaProgram` after `confirm_dispensed` |
| Anchor on-chain support | ✅ | `delegate_session` + `commit_and_undelegate_session` instructions on Rift program |
| Health endpoint flag | ✅ | atm-connector.js line 2982: `flags.magicblock` exposed via `/health` |
| Feature gate | ✅ | `USE_MAGICBLOCK=1` in `.env` toggles activation |
| ER endpoint | ✅ | `https://eu.magicblock.app` (EU region, configurable via env) |
| Fail-safe fallback | ✅ | try/catch around every ER call — BUY continues on mainnet if ER unavailable |

## On-chain footprint

The Rift Anchor program (deployed on Solana mainnet) exposes two purpose-built instructions for MagicBlock ER delegation:

```rust
pub fn delegate_session(
    ctx: Context<DelegateSession>,
) -> Result<()> {
    // CPI into MagicBlock delegation program with operator + claim PDA seeds
    // Hands both accounts to the ER validator
}

pub fn commit_and_undelegate_session(
    ctx: Context<CommitAndUndelegateSession>,
) -> Result<()> {
    // Called on the ER side
    // Schedules commit back to base layer + releases account ownership
}
```

These live in `programs/rift-atm/src/lib.rs` and are signed by the Rift program (which owns the operator + claim PDAs), not by an external client. This is the correct PDA-safe pattern: external delegation programs cannot sign for PDAs.

## Live ATM context

The integration runs inside a working fiat-to-crypto ATM stack deployed on Solana mainnet:

| Service | Port | Role |
|---|---|---|
| `atm-connector.js` (Node) | 8790 | Core BUY/SELL orchestrator — hosts the MagicBlock integration |
| `server.py` (Flask) | 5000 | Admin console + customer-facing kiosk API |
| `printer-bridge.js` (Node/WS) | 8766 | ESC/POS thermal receipt printer |
| `nv200-ws.py` (Python/WS) | 8765 | ITL NV200 banknote validator |
| `essp.py` (Python) | — | ESSP serial protocol for the cash recycler |

The ATM physically accepts EUR cash via the NV200 validator, prices the crypto via Coinbase + Birdeye, and dispenses tokens via Jupiter/LI.FI/Umbra routes — all of which can be wrapped in a MagicBlock ER session when `USE_MAGICBLOCK=1`.

## Smoke verification

With the feature gate enabled, a successful boot logs:
[magicblock] ER program loaded (endpoint=https://eu.magicblock.app)

And the `/health` endpoint reports:

```json
{
  "ok": true,
  "flags": {
    "magicblock": true,
    "umbra": true,
    "ika": false
  }
}
```

A BUY through the live ATM with MagicBlock enabled logs:
[BUY] lock_buy_claim: <claim-pda> sig=<tx>
[BUY] MagicBlock ER session open: <session-id>
[swap] Jupiter route executed on ER
[BUY] confirm_dispensed sig=<tx>
[BUY] MagicBlock ER commit_and_undelegate: <commit-tx-mainnet>

The final `commit_and_undelegate` signature is searchable on Solscan / Solana Explorer.

## Companion script: enable_privacy_mode.js

`scripts/enable_privacy_mode.js` is a one-shot operator tool that enables the `privacy_mode` flag on the on-chain operator account (via `set_privacy_config`). It is idempotent — it reads current state first and skips the TX if already set with the expected viewing key.

```bash
cd backend
node --env-file=.env scripts/enable_privacy_mode.js
```

While not strictly part of the MagicBlock integration, it ships with this repo because operator-side privacy activation is typically configured together with ER delegation in a fresh deployment.

## Repository organization rationale

This repository is deliberately a **clean extract** rather than a fork of the full RIFT codebase. The full RIFT mono-repo contains:

- Production secrets, customer KYC handlers, payment processor credentials
- Anchor program source (audited but not yet open-source)
- Hardware drivers for the cash validator
- Several pre-alpha integrations under active iteration

Publishing those would expose security-sensitive infrastructure that is not relevant to the MagicBlock integration itself. This extract isolates the MagicBlock-specific files so reviewers can audit the integration cleanly.

## License

MIT — Yann Mapouka <yamap@riftatm.com>
