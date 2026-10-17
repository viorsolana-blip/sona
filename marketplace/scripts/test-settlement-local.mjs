#!/usr/bin/env node
/** Real local-validator execution. Uses only fresh test keys and valueless SOL. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { AuthorityType, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority,
  getAccount, createTransferCheckedInstruction } from '@solana/spl-token';
import { buildSettlementTransaction, inspectSettlementAsset, verifyCanonicalSignedTransaction } from '../src/chain/settlement.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const wire = (transaction) => transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

async function findValidator() {
  const candidates = [process.env.SOLANA_TEST_VALIDATOR, '/opt/homebrew/bin/solana-test-validator',
    '/usr/local/bin/solana-test-validator'].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('solana-test-validator is required. Set SOLANA_TEST_VALIDATOR to its absolute binary path.');
}

async function waitForRpc(connection, child, log) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Local validator exited ${child.exitCode}: ${log()}`);
    try { await connection.getLatestBlockhash('confirmed'); return; } catch {}
    await wait(250);
  }
  throw new Error(`Local validator did not start: ${log()}`);
}

async function confirmation(connection, signature, commitment = 'confirmed') {
  for (let attempt = 0; attempt < 400; attempt++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature]);
    if (status && (status.confirmationStatus === 'finalized'
      || (commitment !== 'finalized' && status.confirmationStatus === 'confirmed'))) return status;
    await wait(100);
  }
  throw new Error(`Timed out waiting for local transaction ${signature}`);
}

async function receipt(connection, signature) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (tx) return { signature, slot: tx.slot, blockTime: tx.blockTime,
      error: tx.meta.err, feeLamports: tx.meta.fee, computeUnitsConsumed: tx.meta.computeUnitsConsumed,
      logMessages: tx.meta.logMessages, preBalances: tx.meta.preBalances, postBalances: tx.meta.postBalances,
      preTokenBalances: tx.meta.preTokenBalances, postTokenBalances: tx.meta.postTokenBalances };
    await wait(100);
  }
  throw new Error(`Could not retrieve receipt for ${signature}`);
}

export async function runSettlementLocal({ outputPath = join(projectRoot, 'evidence', 'settlement-local.json'), runBackend } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'sona-settlement-'));
  const rpcPort = 20000 + Math.floor(Math.random() * 20000);
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const genesisWallet = Keypair.generate();
  const seller = Keypair.generate();
  const buyer = Keypair.generate();
  const poorBuyer = Keypair.generate();
  const other = Keypair.generate();
  const validator = await findValidator();
  const configPath = join(temporary, 'validator-config.yml');
  await writeFile(configPath, `json_rpc_url: ${rpcUrl}\nwebsocket_url: ''\nkeypair_path: ${temporary}/unused.json\naddress_labels: {}\ncommitment: confirmed\n`);
  let logs = '';
  const child = spawn(validator, ['--ledger', join(temporary, 'ledger'), '--config', configPath,
    '--rpc-port', String(rpcPort), '--faucet-port', String(rpcPort + 2), '--gossip-port', String(rpcPort + 3),
    '--dynamic-port-range', `${rpcPort + 4}-${rpcPort + 40}`, '--bind-address', '127.0.0.1',
    '--gossip-host', '127.0.0.1', '--mint', genesisWallet.publicKey.toBase58(), '--quiet'],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, COPYFILE_DISABLE: '1' } });
  child.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  child.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-12000); });
  let spawnError;
  child.on('error', (error) => { spawnError = error; });
  const connection = new Connection(rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  // Test fixture helpers otherwise open a websocket for each confirmation. Poll
  // the real RPC status instead so teardown never leaves reconnecting sockets.
  connection.confirmTransaction = async (strategy, commitment = 'confirmed') => {
    const status = await confirmation(connection, typeof strategy === 'string' ? strategy : strategy.signature, commitment);
    return { context: { slot: status.slot }, value: { err: status.err } };
  };
  try {
    await waitForRpc(connection, child, () => spawnError?.message ?? logs);
    const version = await connection.getVersion();
    const genesisHash = await connection.getGenesisHash();
    for (const [key, lamports] of [[seller.publicKey, 2e9], [buyer.publicKey, 4e9], [poorBuyer.publicKey, 1e7], [other.publicKey, 1e8]]) {
      const signature = await connection.requestAirdrop(key, lamports);
      assert.equal((await confirmation(connection, signature)).err, null);
    }
    async function nft() {
      const mint = await createMint(connection, genesisWallet, genesisWallet.publicKey, null, 0);
      const account = await getOrCreateAssociatedTokenAccount(connection, genesisWallet, mint, seller.publicKey);
      await mintTo(connection, genesisWallet, mint, account.address, genesisWallet, 1n);
      await setAuthority(connection, genesisWallet, mint, genesisWallet, AuthorityType.MintTokens, null);
      return { mint, sourceTokenAccount: account.address };
    }
    async function quote(asset, who = buyer, priceLamports = '250000001') {
      await inspectSettlementAsset({ connection, ...asset, seller: seller.publicKey });
      return buildSettlementTransaction({ seller: seller.publicKey, buyer: who.publicKey, ...asset,
        priceLamports, ...await connection.getLatestBlockhash('confirmed') });
    }
    function approve(built, who = buyer) {
      built.transaction.partialSign(seller);
      const partial = verifyCanonicalSignedTransaction({ transactionBase64: wire(built.transaction),
        expectedTransactionBase64: built.transactionBase64, requiredSigners: [seller.publicKey] });
      const buyerTx = Transaction.from(Buffer.from(partial.transactionBase64, 'base64'));
      buyerTx.partialSign(who);
      return verifyCanonicalSignedTransaction({ transactionBase64: wire(buyerTx),
        expectedTransactionBase64: built.transactionBase64, requiredSigners: [seller.publicKey, who.publicKey] }).transaction;
    }

    const cases = [];
    const asset = await nft();
    const built = await quote(asset);
    const final = approve(built);
    const sellerBefore = await connection.getBalance(seller.publicKey);
    const buyerBefore = await connection.getBalance(buyer.publicKey);
    const successSignature = await connection.sendRawTransaction(final.serialize(), { skipPreflight: false });
    assert.equal((await confirmation(connection, successSignature)).err, null);
    assert.equal((await getAccount(connection, asset.sourceTokenAccount)).amount, 0n);
    assert.equal((await getAccount(connection, new (asset.mint.constructor)(built.destinationTokenAccount))).amount, 1n);
    const sellerAfter = await connection.getBalance(seller.publicKey);
    const buyerAfter = await connection.getBalance(buyer.publicKey);
    assert.equal(sellerAfter - sellerBefore, Number(built.priceLamports));
    assert(buyerBefore - buyerAfter > Number(built.priceLamports));
    cases.push({ name: 'atomic NFT transfer and exact SOL payment', passed: true, mint: String(asset.mint),
      buyer: String(buyer.publicKey), seller: String(seller.publicKey), priceLamports: built.priceLamports,
      sellerBefore, sellerAfter, buyerBefore, buyerAfter, messageSha256: built.messageSha256,
      transactionBase64: final.serialize().toString('base64'), receipt: await receipt(connection, successSignature) });

    // Sending identical signed bytes can return the same signature; it must not
    // execute twice or charge the trade price/transaction fee a second time.
    let replayResponse;
    try { replayResponse = await connection.sendRawTransaction(final.serialize(), { skipPreflight: false, maxRetries: 0 }); }
    catch (error) { replayResponse = error.message; }
    await wait(500);
    assert.equal(await connection.getBalance(seller.publicKey), sellerAfter);
    assert.equal(await connection.getBalance(buyer.publicKey), buyerAfter);
    assert.equal((await getAccount(connection, new (asset.mint.constructor)(built.destinationTokenAccount))).amount, 1n);
    cases.push({ name: 'replay cannot execute or debit twice', passed: true, originalSignature: successSignature, replayResponse });

    const failAsset = await nft();
    const failQuote = await quote(failAsset, poorBuyer, '3000000000');
    const failed = approve(failQuote, poorBuyer);
    const failSellerBefore = await connection.getBalance(seller.publicKey);
    const failBuyerBefore = await connection.getBalance(poorBuyer.publicKey);
    const failedSignature = await connection.sendRawTransaction(failed.serialize(), { skipPreflight: true, maxRetries: 0 });
    const failedStatus = await confirmation(connection, failedSignature);
    assert.notEqual(failedStatus.err, null);
    assert.equal((await getAccount(connection, failAsset.sourceTokenAccount)).amount, 1n);
    assert.equal(await connection.getAccountInfo(new (asset.mint.constructor)(failQuote.destinationTokenAccount)), null);
    assert.equal(await connection.getBalance(seller.publicKey), failSellerBefore);
    const failedReceipt = await receipt(connection, failedSignature);
    assert.equal(failBuyerBefore - await connection.getBalance(poorBuyer.publicKey), failedReceipt.feeLamports);
    cases.push({ name: 'insufficient SOL rolls back NFT transfer and ATA creation; only network fee charged', passed: true,
      sourceAmountAfter: '1', destinationExistsAfter: false, sellerPaymentLamports: '0', receipt: failedReceipt });

    const movedAsset = await nft();
    const staleQuote = await quote(movedAsset);
    const staleTx = approve(staleQuote);
    const otherAta = await getOrCreateAssociatedTokenAccount(connection, genesisWallet, movedAsset.mint, other.publicKey);
    const move = new Transaction().add(createTransferCheckedInstruction(movedAsset.sourceTokenAccount, movedAsset.mint,
      otherAta.address, seller.publicKey, 1n, 0));
    await sendAndConfirmTransaction(connection, move, [seller]);
    await assert.rejects(inspectSettlementAsset({ connection, ...movedAsset, seller: seller.publicKey }), { code: 'NOT_OWNED' });
    const staleSellerBefore = await connection.getBalance(seller.publicKey);
    const staleSignature = await connection.sendRawTransaction(staleTx.serialize(), { skipPreflight: true, maxRetries: 0 });
    assert.notEqual((await confirmation(connection, staleSignature)).err, null);
    assert.equal(await connection.getBalance(seller.publicKey), staleSellerBefore);
    assert.equal((await getAccount(connection, otherAta.address)).amount, 1n);
    cases.push({ name: 'moved ownership blocks settlement without paying the seller', passed: true,
      receipt: await receipt(connection, staleSignature) });

    const signatureAsset = await nft();
    const signatureQuote = await quote(signatureAsset);
    const forged = approve(signatureQuote);
    forged.signatures[0].signature[0] ^= 255;
    await assert.rejects(connection.sendRawTransaction(forged.serialize({ verifySignatures: false }), { skipPreflight: false }), /signature verification|Signature verification/i);
    assert.equal((await getAccount(connection, signatureAsset.sourceTokenAccount)).amount, 1n);
    cases.push({ name: 'validator rejects a forged buyer signature', passed: true });

    const tampered = buildSettlementTransaction({ ...signatureQuote, priceLamports: '1' });
    assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: tampered.transactionBase64,
      expectedTransactionBase64: signatureQuote.transactionBase64 }), { code: 'TRANSACTION_CHANGED' });
    const redirected = buildSettlementTransaction({ ...signatureQuote, buyer: other.publicKey });
    assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: redirected.transactionBase64,
      expectedTransactionBase64: signatureQuote.transactionBase64 }), { code: 'TRANSACTION_CHANGED' });
    cases.push({ name: 'canonical server verification rejects changed price and recipient', passed: true });

    if (runBackend) await runBackend({ connection, seller, buyer, other, poorBuyer, nft, genesisWallet });

    const hashes = {};
    for (const relative of ['src/chain/settlement.mjs', 'scripts/test-settlement-local.mjs', 'tests/settlement.test.mjs']) {
      hashes[relative] = createHash('sha256').update(await readFile(join(projectRoot, relative))).digest('hex');
    }
    const report = { schema: 'sona-settlement-local-evidence-v1', generatedAt: new Date().toISOString(),
      environment: 'isolated local solana-test-validator; valueless test SOL and freshly minted SPL NFT fixtures',
      scope: 'Real SPL Token/Associated Token/System Program execution and client transaction-integrity checks. This does not prove Raydium mainnet Fee Key settlement or public deployment.',
      validator: { ...version, genesisHash }, privateKeysPersisted: false, sourceSha256: hashes, cases,
      passed: cases.length, failed: 0 };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
    return report;
  } finally {
    child.kill('SIGTERM');
    for (let attempt = 0; attempt < 30 && child.exitCode === null; attempt++) await wait(100);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSettlementLocal().then((result) => {
    console.log(JSON.stringify({ passed: result.passed, failed: result.failed,
      evidence: 'evidence/settlement-local.json', environment: result.environment }, null, 2));
  }).catch((error) => { console.error(error); process.exitCode = 1; });
}
