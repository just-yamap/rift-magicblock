/**
 * MagicBlock Ephemeral Rollups — real SDK integration.
 *
 * Frontier track: $5k USDC (Privacy Track, co-sponsored with SNS + STMY).
 * Install: `npm install @magicblock-labs/ephemeral-rollups-sdk` (0.10.5 in backend/node_modules).
 *
 * Flow wrapped here:
 *   openSession       — delegate Operator + Claim PDAs to the MagicBlock ER
 *                       validator so mutations against them go to ER (<50 ms)
 *                       instead of mainnet/devnet.
 *   (caller does the lock_buy_claim / confirm_dispensed cycle in between)
 *   commitAndClose    — commit the final state back to mainnet and release
 *                       the accounts from the ER.
 *
 * Call signatures match what atm-connector.js uses:
 *
 *   const session = await magicblock.openSession({
 *     connection, operatorSigner, operatorPda, claimPda,
 *   });
 *   // ... do ER-routed work here ...
 *   await magicblock.commitAndClose({
 *     connection, operatorSigner, sessionId: session.sessionId,
 *   });
 *
 * On-chain path:
 *   Rift program exposes two Anchor instructions for ER delegation:
 *     • `delegate_session`                — CPIs into the delegation
 *       program with operator + claim PDA seeds to hand both accounts
 *       to the ER validator.
 *     • `commit_and_undelegate_session`   — called on the ER; schedules
 *       commit back to base + releases ownership.
 *   These live in programs/rift-atm/src/lib.rs and are preferable to
 *   calling the delegation program standalone (which can't sign for PDAs).
 *
 *   Use `openSessionViaProgram({ program, ... })` below for the
 *   Anchor-program-CPI path. `openSession({ ... })` remains available
 *   for delegating keypair-owned accounts (non-PDA).
 */
'use strict';

let MB = null;
try { MB = require('@magicblock-labs/ephemeral-rollups-sdk'); } catch { /* optional */ }

const { Transaction, Connection, PublicKey } = require('@solana/web3.js');
const crypto = require('node:crypto');

function ensureSdk() {
  if (!MB) throw new Error('@magicblock-labs/ephemeral-rollups-sdk not installed');
}

const RIFT_PROGRAM_ID = () => {
  if (!process.env.RIFT_PROGRAM_ID) throw new Error('[magicblock] RIFT_PROGRAM_ID not set');
  return new PublicKey(process.env.RIFT_PROGRAM_ID);
};

// In-memory registry of live sessions so commitAndClose can look up the
// accounts we delegated at openSession time.
const LIVE_SESSIONS = new Map();

/**
 * Build a delegate instruction for a single account.
 *   payer            — the wallet that pays the delegation rent
 *   delegatedAccount — account being handed over to the ER
 *   ownerProgram     — the program that currently owns the account
 */
function delegateIx({ payer, delegatedAccount, ownerProgram }) {
  ensureSdk();
  return MB.createDelegateInstruction({
    payer,
    delegatedAccount,
    ownerProgram,
  });
}

/**
 * Build the commit-and-undelegate instruction that rolls ER state back
 * to the base chain and releases the accounts.
 */
function commitAndUndelegateIx({ payer, accountsToCommit }) {
  ensureSdk();
  return MB.createCommitAndUndelegateInstruction(payer, accountsToCommit);
}

/**
 * Return a @solana/web3.js Connection pointed at the MagicBlock ER RPC.
 * Use this in place of the mainnet/devnet connection between openSession
 * and commitAndClose.
 *
 * The ER endpoint URL is provisioned per-cluster. For devnet:
 *   MAGICBLOCK_ER_ENDPOINT=https://devnet.magicblock.app
 */
function erConnection() {
  const url = process.env.MAGICBLOCK_ER_ENDPOINT || 'https://devnet.magicblock.app';
  return new Connection(url, 'confirmed');
}

/**
 * Open a session by delegating the given rift PDAs to the MagicBlock ER.
 * Returns `{ sessionId, signature, delegatedAccounts }`.
 *
 * The ER endpoint URL is provisioned per-cluster; after this returns the
 * caller may switch their Anchor provider's connection to `erConnection()`
 * for the duration of the session.
 *
 * @param {object}  opts
 * @param {Connection} opts.connection     mainnet/devnet connection
 * @param {object}  opts.operatorSigner    { publicKey, signTransaction }
 * @param {PublicKey} opts.operatorPda     operator account PDA
 * @param {PublicKey} opts.claimPda        per-buy claim PDA
 * @param {PublicKey=} opts.programId      rift program id (default from env)
 * @param {PublicKey[]=} opts.extraAccounts additional accounts to delegate
 */
async function openSession(opts) {
  ensureSdk();
  const {
    connection,
    operatorSigner,
    operatorPda,
    claimPda,
    programId = RIFT_PROGRAM_ID(),
    extraAccounts = [],
  } = opts;

  if (!operatorSigner || !operatorSigner.publicKey || !operatorSigner.signTransaction) {
    throw new Error('magicblock.openSession: operatorSigner must have publicKey + signTransaction');
  }

  const payer = operatorSigner.publicKey;
  const delegated = [operatorPda, claimPda, ...extraAccounts].filter(Boolean);

  const tx = new Transaction();
  for (const acct of delegated) {
    tx.add(delegateIx({ payer, delegatedAccount: acct, ownerProgram: programId }));
  }
  tx.feePayer = payer;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signed = await operatorSigner.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  const sessionId = crypto.randomBytes(16).toString('hex');
  // INT-30: collision check + INT-24: LRU cap at 1000 sessions
  if (LIVE_SESSIONS.has(sessionId)) throw new Error('sessionId collision — retry');
  if (LIVE_SESSIONS.size >= 1000) {
    const oldest = LIVE_SESSIONS.keys().next().value;
    LIVE_SESSIONS.delete(oldest);
  }
  LIVE_SESSIONS.set(sessionId, {
    delegatedAccounts: delegated,
    programId,
    openedAt: Date.now(),
    openTxSig: signature,
  });

  return {
    sessionId,
    signature,
    delegatedAccounts: delegated.map((a) => a.toBase58()),
  };
}

/**
 * Commit ER state back to the base chain and undelegate the accounts.
 * Looks up the account set via sessionId captured at openSession.
 */
async function commitAndClose(opts) {
  ensureSdk();
  const { connection, operatorSigner, sessionId } = opts;

  if (!operatorSigner || !operatorSigner.publicKey || !operatorSigner.signTransaction) {
    throw new Error('magicblock.commitAndClose: operatorSigner must have publicKey + signTransaction');
  }
  const live = LIVE_SESSIONS.get(sessionId);
  if (!live) throw new Error(`magicblock.commitAndClose: unknown sessionId ${sessionId}`);

  const tx = new Transaction().add(
    commitAndUndelegateIx({ payer: operatorSigner.publicKey, accountsToCommit: live.delegatedAccounts }),
  );
  tx.feePayer = operatorSigner.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const signed = await operatorSigner.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, 'confirmed');

  LIVE_SESSIONS.delete(sessionId);
  return { signature };
}

/**
 * Inspect the live session registry (useful for debugging / admin UI).
 */
function liveSessions() {
  return Array.from(LIVE_SESSIONS.entries()).map(([id, s]) => ({
    sessionId:         id,
    openedAt:          s.openedAt,
    delegatedAccounts: s.delegatedAccounts.map((a) => a.toBase58()),
  }));
}

/**
 * PDA-friendly session open: calls `program.methods.delegateSession()` on
 * the rift-atm program, which in turn CPIs into the delegation program
 * with PDA seeds. This is the correct path for delegating Operator +
 * Claim PDAs (they can't sign standalone delegate ixs).
 *
 * Requires the rift program has been redeployed with the new
 * delegate_session instruction in place (see programs/rift-atm/src/lib.rs).
 */
async function openSessionViaProgram({ program, operatorPda, claimPda, authority }) {
  ensureSdk();
  // PDAs for the delegation program's scratch accounts — derived from
  // the SDK. These addresses match what er_cpi_delegate expects on-chain.
  const {
    delegateBufferPdaFromDelegatedAccountAndOwnerProgram,
    delegationRecordPdaFromDelegatedAccount,
    delegationMetadataPdaFromDelegatedAccount,
    DELEGATION_PROGRAM_ID,
  } = MB;

  const programId = program.programId;
  const opBuffer   = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(operatorPda, programId);
  const opRecord   = delegationRecordPdaFromDelegatedAccount(operatorPda);
  const opMetadata = delegationMetadataPdaFromDelegatedAccount(operatorPda);
  const cBuffer    = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(claimPda, programId);
  const cRecord    = delegationRecordPdaFromDelegatedAccount(claimPda);
  const cMetadata  = delegationMetadataPdaFromDelegatedAccount(claimPda);

  const sig = await program.methods
    .delegateSession()
    .accounts({
      authority,
      operator:                     operatorPda,
      claim:                        claimPda,
      riftProgram:                  programId,
      operatorDelegationBuffer:     opBuffer,
      operatorDelegationRecord:     opRecord,
      operatorDelegationMetadata:   opMetadata,
      claimDelegationBuffer:        cBuffer,
      claimDelegationRecord:        cRecord,
      claimDelegationMetadata:      cMetadata,
      delegationProgram:            DELEGATION_PROGRAM_ID,
      systemProgram:                require('@solana/web3.js').SystemProgram.programId,
    })
    .rpc();

  const sessionId = require('node:crypto').randomBytes(16).toString('hex');
  LIVE_SESSIONS.set(sessionId, {
    delegatedAccounts: [operatorPda, claimPda],
    programId,
    openedAt: Date.now(),
    openTxSig: sig,
  });

  return { sessionId, signature: sig, delegatedAccounts: [operatorPda.toBase58(), claimPda.toBase58()] };
}

/**
 * Close an Anchor-CPI-opened session: runs on the ER, calls
 * `program.methods.commitAndUndelegateSession()`.
 */
async function commitAndCloseViaProgram({ program, erProgram, sessionId, authority }) {
  ensureSdk();
  const live = LIVE_SESSIONS.get(sessionId);
  if (!live) throw new Error(`magicblock.commitAndCloseViaProgram: unknown sessionId ${sessionId}`);

  const [operatorPda, claimPda] = live.delegatedAccounts;
  const p = erProgram || program;  // ER version of the program (same ID, different RPC)
  const sig = await p.methods
    .commitAndUndelegateSession()
    .accounts({
      authority,
      operator:      operatorPda,
      claim:         claimPda,
      magicContext:  MB.MAGIC_CONTEXT_ID,
      magicProgram:  MB.MAGIC_PROGRAM_ID,
    })
    .rpc();

  LIVE_SESSIONS.delete(sessionId);
  return { signature: sig };
}

module.exports = {
  openSession,
  commitAndClose,
  openSessionViaProgram,
  commitAndCloseViaProgram,
  erConnection,
  delegateIx,
  commitAndUndelegateIx,
  liveSessions,
};
