# Wiring MagicBlock into the RIFT BUY Flow

This document shows the exact integration points where `integration/magicblock.js` plugs into the production backend (`atm-connector.js` in the live RIFT stack).

The integration is **additive** and **fail-safe**: each MagicBlock call is wrapped in a try/catch, and the BUY automatically falls back to mainnet-only execution if the ER endpoint, SDK, or delegation fails.

---

## 1. Boot-time setup (atm-connector.js ~line 627)

At backend startup, an Anchor `Program` instance is constructed against the MagicBlock ER endpoint, signed by the operator authority. This program object is the bridge for all subsequent ER calls.

```js
// ── MagicBlock ER: build operator-signed Program connected to ER endpoint ──
if (CFG.useMagicBlock) {
  try {
    const erEndpoint = process.env.MAGICBLOCK_ER_ENDPOINT
      || 'https://eu.magicblock.app';
    const erConn = new Connection(erEndpoint, 'confirmed');
    const erProvider = new anchor.AnchorProvider(erConn, signingWallet, {});
    erProgram = new anchor.Program(idl, erProvider);
    console.log(`[magicblock] ER program loaded (endpoint=${erEndpoint})`);
  } catch (e) {
    console.warn(`[magicblock] ER program init failed (ER will use mainnet fallback): ${e.message}`);
    erProgram = null;
  }
}
```

- `CFG.useMagicBlock` is derived from `process.env.USE_MAGICBLOCK === '1'`
- If `erProgram` stays null, the BUY skips ER entirely and runs purely on mainnet

---

## 2. Open ER session AFTER lock_buy_claim (atm-connector.js ~line 1024)

The session is opened **after** `lock_buy_claim` creates the Claim PDA on mainnet — the Claim must exist before it can be delegated.

```js
// ── 3b. MagicBlock ER: delegate Operator + Claim PDAs ──
let erSession = null;
if (CFG.useMagicBlock && erProgram) {
  try {
    erSession = await magicblock.openSessionViaProgram({
      program: erProgram,
      operatorAuthority: signingWallet.publicKey,
      operatorPda,
      claimPda,
    });
    console.log(`[BUY] MagicBlock ER session open: ${erSession.sessionId}`);
  } catch (e) {
    console.warn(`[BUY] MagicBlock ER session failed (mainnet fallback): ${e.message}`);
    erSession = null;
  }
}
```

- The PDA-safe CPI path is `openSessionViaProgram`, which routes through Rift's on-chain `delegate_session` instruction
- Failure is non-blocking: `erSession = null` → next steps execute on mainnet as usual

---

## 3. The swap happens on ER (sub-50ms per state mutation)

While the ER session is live, all program calls touching the Operator or Claim PDAs are routed to the MagicBlock ER validator instead of mainnet. The swap branch (Jupiter / LI.FI / Umbra) executes its on-chain state updates against the ER, dropping latency from 400-800ms per tx to <50ms.

No code change is needed in the swap itself — Anchor's `Program` object is already pointed at the ER endpoint via `erProvider`.

---

## 4. Commit & close the session (atm-connector.js ~line 1273)

After `confirm_dispensed` settles the Claim on the ER, the final state is committed back to mainnet and both PDAs are released from the ER validator.

```js
// ── 8. Commit & close ER session ──
if (erSession) {
  try {
    const { signature } = await magicblock.commitAndCloseViaProgram({
      program: erProgram,
      sessionId: erSession.sessionId,
      operatorPda,
      claimPda,
    });
    console.log(`[BUY] MagicBlock ER commit_and_undelegate: ${signature}`);
  } catch (e) {
    console.warn(`[BUY] MagicBlock ER commit failed (state stays on ER, harmless): ${e.message}`);
  }
}
```

- The commit returns a mainnet TX signature — this is the **proof of ER usage** that appears on Solscan
- Even if the commit step fails, the ATM has already dispensed the crypto to the customer (settle happened on ER)

---

## 5. Health endpoint exposes ER state (atm-connector.js ~line 2982)

The connector's `/health` endpoint includes a `flags` object showing which integrations are active in the current process:

```js
flags: {
  ika: CFG.useIka,
  umbra: CFG.useUmbra,
  magicblock: CFG.useMagicBlock,
}
```

This lets operators verify activation from any monitoring tool by hitting `/health` and reading `flags.magicblock`.

---

## On-chain program support

The Anchor program at `programs/rift-atm/src/lib.rs` exposes two instructions specifically for ER delegation:

| Instruction | Purpose |
|---|---|
| `delegate_session` | CPIs into the MagicBlock delegation program with operator + claim PDA seeds, handing both accounts to the ER validator |
| `commit_and_undelegate_session` | Called on the ER side; schedules a commit back to base layer and releases account ownership |

Using these Anchor-level instructions (rather than calling the delegation program directly) is required because the PDAs cannot sign for themselves — the program needs to be the signer.

---

## Activation steps for a fresh deployment

```bash
# 1. Install SDK (already in package.json)
npm install @magicblock-labs/ephemeral-rollups-sdk@^0.10.5

# 2. Enable in .env
echo "USE_MAGICBLOCK=1" >> .env
echo "MAGICBLOCK_ER_ENDPOINT=https://eu.magicblock.app" >> .env

# 3. Restart the connector
pkill -f atm-connector
node --env-file=.env atm-connector.js > /tmp/rift_connector.log 2>&1 &

# 4. Verify at boot
grep "magicblock" /tmp/rift_connector.log
# Expect: "[magicblock] ER program loaded (endpoint=https://eu.magicblock.app)"

# 5. Verify flag is exposed
curl -s http://localhost:8790/health | python3 -m json.tool | grep magicblock
# Expect: "magicblock": true
```

The next BUY transaction will go through the ER. Look for these lines in the log:
[BUY] MagicBlock ER session open: <sessionId>
... swap executes on ER ...
[BUY] MagicBlock ER commit_and_undelegate: <mainnet-tx-signature>

The commit signature is the on-chain proof of ER usage — searchable on Solscan.
