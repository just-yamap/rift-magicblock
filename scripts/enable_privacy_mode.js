#!/usr/bin/env node
/**
 * One-shot script: enable Umbra privacy mode on the on-chain operator account.
 *
 * Calls program.methods.setPrivacyConfig(true, viewingKeyPubkey) signed by
 * the operator authority (FuePxPf2). Idempotent — prints current state first,
 * skips TX if already enabled with the expected viewing key.
 *
 * Usage:
 *   cd ~/rift-solana/backend
 *   node --env-file=.env scripts/enable_privacy_mode.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const anchor = require('@coral-xyz/anchor');
const { PublicKey } = require('@solana/web3.js');

async function main() {
  // ── Load operator keypair ──
  const kpPath = process.env.OPERATOR_KEYPAIR_PATH || process.env.ANCHOR_WALLET;
  if (!kpPath) {
    console.error('ERROR: set OPERATOR_KEYPAIR_PATH or ANCHOR_WALLET env var pointing to your operator keypair.json');
    process.exit(1);
  }
  if (!fs.existsSync(kpPath)) {
    console.error(`ERROR: operator keypair not found at ${kpPath}`);
    process.exit(1);
  }
  const kp = anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, 'utf8')))
  );
  console.log(`Operator authority: ${kp.publicKey.toBase58()}`);

  // ── Connect ──
  const rpcUrl = process.env.SOLANA_RPC || process.env.RPC_FAST_URL || 'https://api.mainnet-beta.solana.com';
  const connection = new anchor.web3.Connection(rpcUrl, 'confirmed');
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });

  // ── Load IDL + program ──
  const idlPath = process.env.IDL_PATH || path.join(__dirname, '..', '..', 'target', 'idl', 'rift_atm.json');
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  const program = new anchor.Program(idl, provider);
  console.log(`Program: ${program.programId.toBase58()}`);

  // ── Derive operator PDA ──
  const [operatorPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('operator'), kp.publicKey.toBuffer()],
    program.programId
  );
  console.log(`Operator PDA: ${operatorPda.toBase58()}`);

  // ── Read current state ──
  let operatorAcc;
  try {
    operatorAcc = await program.account.operator.fetch(operatorPda);
  } catch (e) {
    console.error(`ERROR: cannot fetch operator account: ${e.message}`);
    process.exit(1);
  }
  console.log(`Current privacy_mode: ${operatorAcc.privacyMode}`);
  console.log(`Current viewing_key:  ${operatorAcc.viewingKeyPubkey.toBase58()}`);

  // ── Decide viewing key ──
  // Use the operator authority pubkey itself as viewing key for now.
  // Can be rotated later to a dedicated X25519 key.
  const viewingKey = kp.publicKey;

  // ── Check if already set ──
  if (operatorAcc.privacyMode === true && operatorAcc.viewingKeyPubkey.equals(viewingKey)) {
    console.log('\nAlready enabled with correct viewing key — no TX needed.');
    process.exit(0);
  }

  // ── Send TX ──
  console.log(`\nSetting privacy_mode=true, viewing_key=${viewingKey.toBase58()}...`);
  const sig = await program.methods
    .setPrivacyConfig(true, viewingKey)
    .accounts({
      authority: kp.publicKey,
      operator: operatorPda,
    })
    .rpc();

  console.log(`TX: ${sig}`);
  console.log('Done. Privacy mode enabled on-chain.');
}

main().catch(e => {
  console.error(`FATAL: ${e.message}`);
  process.exit(1);
});
