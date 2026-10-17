#!/usr/bin/env node
/** Public devnet proof using fresh ephemeral keys and ONE free faucet request. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { AuthorityType, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, getAccount } from '@solana/spl-token';
import { buildSettlementTransaction, inspectSettlementAsset, verifyCanonicalSignedTransaction } from '../src/chain/settlement.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RPC = 'https://api.devnet.solana.com';
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const wire = (tx) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

async function confirmByPolling(connection, signature, commitment = 'confirmed') {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    if (status && (status.confirmationStatus === 'finalized'
      || (commitment !== 'finalized' && status.confirmationStatus === 'confirmed'))) {
      return { context: { slot: status.slot }, value: { err: status.err } };
    }
    await wait(1000);
  }
  throw new Error(`Confirmation timed out; inspect the public signature before retrying: ${signature}`);
}

export async function runSettlementDevnet({ outputPath = join(projectRoot, 'evidence', 'settlement-devnet.json') } = {}) {
  const payer = Keypair.generate(), seller = Keypair.generate(), buyer = Keypair.generate();
  const connection = new Connection(RPC, { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }) });
  connection.confirmTransaction = async (strategy, commitment = 'confirmed') => confirmByPolling(connection,
    typeof strategy === 'string' ? strategy : strategy.signature, commitment);
  const report = {
    schema: 'sona-settlement-devnet-evidence-v1', generatedAt: new Date().toISOString(), rpc: RPC, cluster: 'devnet',
    scope: 'Public devnet execution of the canonical SPL NFT-for-SOL settlement. The minted NFT is a test fixture, not a Raydium Fee Key. This is not proof of mainnet marketplace deployment or mainnet settlement.',
    privateKeysPersisted: false, usesExistingWallets: false, paidServicesUsed: false, faucetRequests: 0,
    payer: payer.publicKey.toBase58(), seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(),
    transactions: [], status: 'pending', stage: 'network-check',
  };
  try {
    report.genesisHash = await connection.getGenesisHash();
    // Solana's documented CAIP-2 devnet prefix. The endpoint is hardcoded; no
    // mainnet or user-configured RPC/keypair can be accidentally used here.
    if (!report.genesisHash.startsWith('EtWTRABZaYq6iMfeYKouRu166VU2xqa1')) throw new Error('RPC is not the expected devnet cluster.');
    report.stage = 'free-faucet';
    report.faucetRequests = 1;
    const airdrop = await connection.requestAirdrop(payer.publicKey, 100_000_000);
    report.transactions.push({ purpose: 'free valueless devnet SOL', signature: airdrop });
    assert.equal((await confirmByPolling(connection, airdrop, 'finalized')).value.err, null);

    report.stage = 'fixture-creation';
    const funding = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: seller.publicKey, lamports: 2_000_000n }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 20_000_000n }),
    );
    const fundingSignature = await sendAndConfirmTransaction(connection, funding, [payer]);
    report.transactions.push({ purpose: 'fund fresh test participants', signature: fundingSignature });
    const mint = await createMint(connection, payer, payer.publicKey, null, 0);
    const source = await getOrCreateAssociatedTokenAccount(connection, payer, mint, seller.publicKey);
    await mintTo(connection, payer, mint, source.address, payer, 1n);
    await setAuthority(connection, payer, mint, payer, AuthorityType.MintTokens, null);
    report.mint = mint.toBase58(); report.sourceTokenAccount = source.address.toBase58();
    await inspectSettlementAsset({ connection, seller: seller.publicKey, mint, sourceTokenAccount: source.address });

    report.stage = 'atomic-settlement';
    const settlement = buildSettlementTransaction({ seller: seller.publicKey, buyer: buyer.publicKey, mint,
      sourceTokenAccount: source.address, priceLamports: '5000001', ...await connection.getLatestBlockhash('confirmed') });
    settlement.transaction.partialSign(seller);
    const partial = verifyCanonicalSignedTransaction({ transactionBase64: wire(settlement.transaction),
      expectedTransactionBase64: settlement.transactionBase64, requiredSigners: [seller.publicKey] });
    const final = Transaction.from(Buffer.from(partial.transactionBase64, 'base64'));
    final.partialSign(buyer);
    const checked = verifyCanonicalSignedTransaction({ transactionBase64: wire(final),
      expectedTransactionBase64: settlement.transactionBase64, requiredSigners: [seller.publicKey, buyer.publicKey] });
    const sellerBefore = await connection.getBalance(seller.publicKey);
    const signature = await connection.sendRawTransaction(checked.transaction.serialize(), { skipPreflight: false, maxRetries: 2 });
    report.transactions.push({ purpose: 'atomic NFT-for-SOL settlement', signature });
    report.signature = signature;
    report.explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
    const confirmation = await confirmByPolling(connection, signature, 'finalized');
    assert.equal(confirmation.value.err, null);
    const sellerAfter = await connection.getBalance(seller.publicKey, 'finalized');
    assert.equal(sellerAfter - sellerBefore, Number(settlement.priceLamports));
    assert.equal((await getAccount(connection, source.address, 'finalized')).amount, 0n);
    const destination = await getAccount(connection, new PublicKey(settlement.destinationTokenAccount), 'finalized');
    assert.equal(destination.amount, 1n);
    assert(destination.owner.equals(buyer.publicKey));
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    assert(tx && tx.meta && tx.meta.err === null);
    report.receipt = { slot: tx.slot, blockTime: tx.blockTime, commitment: 'finalized', error: tx.meta.err,
      feeLamports: tx.meta.fee, logMessages: tx.meta.logMessages, preBalances: tx.meta.preBalances,
      postBalances: tx.meta.postBalances, preTokenBalances: tx.meta.preTokenBalances, postTokenBalances: tx.meta.postTokenBalances };
    report.assertions = { sellerReceivedExactLamports: settlement.priceLamports, sellerBefore, sellerAfter,
      sourceNftAmount: '0', buyerNftAmount: '1', destinationTokenAccount: settlement.destinationTokenAccount };
    report.messageSha256 = settlement.messageSha256;
    report.transactionBase64 = checked.transaction.serialize().toString('base64');
    report.status = 'passed'; report.stage = 'complete';
  } catch (error) {
    report.status = ['network-check', 'free-faucet'].includes(report.stage) ? 'blocked' : 'failed';
    report.reason = error.message;
    report.nextStep = report.status === 'blocked'
      ? 'No repeated faucet requests were made. Rerun only when the public devnet faucet/RPC is available.'
      : 'Inspect recorded public transaction signatures and the failing stage before rerunning.';
  }
  report.sourceSha256 = {};
  for (const relative of ['src/chain/settlement.mjs', 'scripts/test-settlement-devnet.mjs']) {
    report.sourceSha256[relative] = createHash('sha256').update(await readFile(join(projectRoot, relative))).digest('hex');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSettlementDevnet().then((report) => {
    console.log(JSON.stringify({ status: report.status, stage: report.stage, reason: report.reason,
      explorerUrl: report.explorerUrl, evidence: 'evidence/settlement-devnet.json' }, null, 2));
    if (report.status !== 'passed') process.exitCode = 2;
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
