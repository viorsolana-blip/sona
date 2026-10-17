import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSettlementTransaction } from '../src/chain/settlement.mjs';
import { GENESIS_HASHES } from '../src/server/network.mjs';
import { normalizeSaleTerms, preflightMainnetSale, verifyMainnetSale } from '../src/verification/mainnet-sale.mjs';

// Reuse the documented public account-layout snapshot. Wallet ownership and
// all transaction responses below are synthetic test fixtures, NOT mainnet proof.
const source = readFileSync(new URL('./raydium.test.mjs', import.meta.url), 'utf8');
const snapshot = JSON.parse(source.match(/const PUBLIC_FIXTURE = (\{[\s\S]*?\n\});/)[1]);
const MINT = 'GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o';
const SOURCE = '6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7';
const SLOT = 500_000_000, FEE = 10_000, RENT = 2_039_280;

function setup({ existingAta = false } = {}) {
  const seller = Keypair.generate(), buyer = Keypair.generate();
  const terms = { mint: MINT, seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), sourceTokenAccount: SOURCE, priceLamports: '123456789' };
  const target = getAssociatedTokenAddressSync(new PublicKey(MINT), buyer.publicKey).toBase58();
  const accounts = Object.fromEntries(Object.entries(snapshot.accounts).map(([key, info]) => [key, {
    ...info, owner: new PublicKey(info.owner), data: Buffer.from(info.data[0], 'base64'),
  }]));
  seller.publicKey.toBuffer().copy(accounts[SOURCE].data, 32);
  const destination = { ...accounts[SOURCE], lamports: RENT, data: Buffer.from(accounts[SOURCE].data) };
  buyer.publicKey.toBuffer().copy(destination.data, 32);destination.data.writeBigUInt64LE(0n, 64);
  if (existingAta) accounts[target] = destination;
  accounts[terms.buyer] = { executable: false, owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 2_000_000_000 };
  accounts[terms.seller] = { executable: false, owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1_000_000_000 };
  const built = buildSettlementTransaction({ ...terms, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: SLOT });
  built.transaction.partialSign(seller, buyer);
  const message = built.transaction.compileMessage(), keys = message.accountKeys.map(String);
  const signatures = built.transaction.signatures.map(entry => bs58.encode(entry.signature)), signature = signatures[0];
  const preBalances = keys.map(key => accounts[key]?.lamports ?? 0), postBalances = [...preBalances];
  const sellerIndex = keys.indexOf(terms.seller), buyerIndex = keys.indexOf(terms.buyer), sourceIndex = keys.indexOf(SOURCE), targetIndex = keys.indexOf(target);
  postBalances[sellerIndex] += Number(terms.priceLamports);
  postBalances[buyerIndex] -= Number(terms.priceLamports) + FEE + (existingAta ? 0 : RENT);
  postBalances[targetIndex] += existingAta ? 0 : RENT;
  const balance = (accountIndex, owner, amount) => ({ accountIndex, mint: MINT, owner, programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { decimals: 0, amount, uiAmount: Number(amount), uiAmountString: amount } });
  const result = { slot: SLOT, blockTime: 1_800_000_000, version: 'legacy', transaction: { message, signatures },
    meta: { err: null, fee: FEE, preBalances, postBalances,
      preTokenBalances: [balance(sourceIndex, terms.seller, '1'), ...(existingAta ? [balance(targetIndex, terms.buyer, '0')] : [])],
      postTokenBalances: [balance(sourceIndex, terms.seller, '0'), balance(targetIndex, terms.buyer, '1')] } };
  const status = { slot: SLOT, err: null, confirmationStatus: 'finalized', confirmations: null };
  const reads = [];let observedSlot = SLOT - 10;
  const connection = {
    async getGenesisHash() { reads.push('genesis'); return GENESIS_HASHES['mainnet-beta']; },
    async getMultipleAccountsInfoAndContext(requested, config) {
      assert.equal(config.commitment, 'finalized');reads.push('accounts');
      return { context: { slot: observedSlot }, value: requested.map(key => accounts[key.toBase58()] ?? null) };
    },
    async getLatestBlockhashAndContext(config) {
      assert.equal(config.commitment, 'finalized');return { context: { slot: observedSlot }, value: { blockhash: built.blockhash, lastValidBlockHeight: SLOT } };
    },
    async getFeeForMessage(estimated, commitment) { assert.equal(commitment, 'finalized');assert.equal(estimated.header.numRequiredSignatures, 2);return { context: { slot: observedSlot }, value: FEE }; },
    async getMinimumBalanceForRentExemption(size, commitment) { assert.equal(size, 165);assert.equal(commitment, 'finalized');return RENT; },
    async getSignatureStatuses(values, options) { assert.deepEqual(values, [signature]);assert.equal(options.searchTransactionHistory, true);return { context: { slot: SLOT }, value: [status] }; },
    async getTransaction(value, config) { assert.equal(value, signature);assert.equal(config.commitment, 'finalized');return result; },
    sendRawTransaction() { assert.fail('Read-only verification must never broadcast.'); },
    requestAirdrop() { assert.fail('Read-only verification must never request funds.'); },
  };
  const finalizeOwnership = () => {
    observedSlot = SLOT + 1;
    accounts[SOURCE].data.writeBigUInt64LE(0n, 64);
    accounts[target] = { ...destination, data: Buffer.from(destination.data) };
    accounts[target].data.writeBigUInt64LE(1n, 64);
  };
  return { terms, target, seller, buyer, accounts, built, signature, result, status, connection, reads, finalizeOwnership,
    verify: options => verifyMainnetSale({ connection, terms, signature, ...options }) };
}

test('preflight verifies actual account layouts and separates price, fee and new ATA rent without writes', async () => {
  const fixture = setup();
  const result = await preflightMainnetSale(fixture);
  assert.equal(result.verified, true);assert.equal(result.readyToSettle, true);
  assert.equal(result.costs.networkFeeLamports, String(FEE));assert.equal(result.costs.buyerAtaRentLamports, String(RENT));
  assert.equal(result.costs.totalEstimatedBuyerDebitLamports, (123456789n + BigInt(FEE + RENT)).toString());
  assert.equal(result.transactionsSent, 0);assert.equal(result.networkWrites, 0);
  assert.equal(result.feeKey.owner, fixture.terms.seller);
  assert.deepEqual(normalizeSaleTerms(result.terms), result.terms);
  assert.throws(() => normalizeSaleTerms({ ...result.terms, destinationTokenAccount: fixture.terms.seller }), { code: 'INVALID_TERMS' });
});

test('existing empty ATA requires no rent and insufficient funds are reported precisely', async () => {
  const fixture = setup({ existingAta: true });fixture.accounts[fixture.terms.buyer].lamports = 1;
  const result = await preflightMainnetSale(fixture);
  assert.equal(result.readyToSettle, false);assert.equal(result.costs.buyerAtaRentLamports, '0');
  assert.equal(result.costs.additionalLamportsNeeded, (123456789n + BigInt(FEE) - 1n).toString());
});

test('private-key fields, self-trades, off-curve wallets and lossy prices are rejected', () => {
  const fixture = setup();
  for (const terms of [
    { ...fixture.terms, privateKey: 'never-accepted' }, { ...fixture.terms, buyer: fixture.terms.seller },
    { ...fixture.terms, buyer: 'AKesWP7KUE9QSnZuU35yQE8HcWQbTsRGMKAbaqESHVrx' },
    { ...fixture.terms, priceLamports: 123456789 }, { ...fixture.terms, priceLamports: '0' },
  ]) assert.throws(() => normalizeSaleTerms(terms));
});

test('preflight rejects wrong genesis, unsafe fees/balances and delegated buyer destinations', async () => {
  const wrong = setup();wrong.connection.getGenesisHash = async () => GENESIS_HASHES.devnet;
  await assert.rejects(preflightMainnetSale(wrong), /genesis/);
  const fee = setup();fee.connection.getFeeForMessage = async () => ({ context: { slot: SLOT }, value: null });
  await assert.rejects(preflightMainnetSale(fee), { code: 'UNSAFE_RPC_NUMBER' });
  const balance = setup();balance.accounts[balance.terms.buyer].lamports = Number.MAX_SAFE_INTEGER + 1;
  await assert.rejects(preflightMainnetSale(balance), { code: 'UNSAFE_RPC_NUMBER' });
  const delegated = setup({ existingAta: true });delegated.accounts[delegated.target].data.writeUInt32LE(1, 72);
  Keypair.generate().publicKey.toBuffer().copy(delegated.accounts[delegated.target].data, 76);
  await assert.rejects(preflightMainnetSale(delegated), { code: 'UNSAFE_DESTINATION' });
});

test('receipt verifies actual signatures, exact token and SOL deltas, current holder and original lock linkage', async () => {
  const fixture = setup();const preflight = await preflightMainnetSale(fixture);fixture.finalizeOwnership();
  const report = await fixture.verify({ preflight, expectedMessageSha256: fixture.built.messageSha256 });
  assert.equal(report.verified, true);assert.equal(report.bothSignaturesVerified, true);
  assert.equal(report.currentFeeKey.owner, fixture.terms.buyer);assert.equal(report.preflightComparison.lockAndPoolLinkageUnchanged, true);
  assert.equal(report.payment.sellerReceivedLamports, fixture.terms.priceLamports);
  assert.equal(report.payment.buyerAtaFundingLamports, String(RENT));
  assert.equal(report.networkWrites, 0);assert.equal(report.receiptComparison, null);
  assert.match(report.sonaAttribution, /Not established/);
  assert.match(report.statement, /cannot establish independent commercial counterparties/);
});

test('receipt supports an existing ATA and exactly matches a supplied Sona receipt without inventing attribution', async () => {
  const fixture = setup({ existingAta: true });fixture.finalizeOwnership();
  const sonaReceipt = { ...fixture.terms, signature: fixture.signature, cluster: 'mainnet-beta', commitment: 'finalized', slot: SLOT, messageSha256: fixture.built.messageSha256 };
  const report = await fixture.verify({ sonaReceipt });
  assert.equal(report.payment.buyerAtaFundingLamports, '0');assert.equal(report.receiptComparison.suppliedReceiptMatched, true);
  assert.match(report.sonaAttribution, /Not established/);
  assert.match(report.historicalRaydiumEligibility, /Not established at the historical transaction slot/);
  await assert.rejects(fixture.verify({ sonaReceipt: { ...sonaReceipt, priceLamports: '1' } }), { code: 'SONA_RECEIPT_MISMATCH' });
});

test('receipt rejects failed, unfinalized, unavailable and inconsistent transaction responses', async () => {
  for (const mutate of [
    fixture => { fixture.status.confirmationStatus = 'confirmed'; },
    fixture => { fixture.result.meta.err = { InstructionError: [1, 'Custom'] }; },
    fixture => { fixture.connection.getTransaction = async () => null; },
    fixture => { fixture.result.slot--; },
  ]) {
    const fixture = setup();fixture.finalizeOwnership();mutate(fixture);
    await assert.rejects(fixture.verify());
  }
});

test('receipt rejects invalid seller signatures and extra instructions even when re-signed', async () => {
  const forged = setup();forged.finalizeOwnership();
  const signature = bs58.decode(forged.result.transaction.signatures[1]);signature[0] ^= 1;
  forged.result.transaction.signatures[1] = bs58.encode(signature);
  await assert.rejects(forged.verify(), { code: 'CANONICAL_TRANSACTION_MISMATCH' });
  const extra = setup();extra.finalizeOwnership();
  extra.built.transaction.add(SystemProgram.transfer({ fromPubkey: extra.buyer.publicKey, toPubkey: extra.seller.publicKey, lamports: 1 }));
  extra.built.transaction.partialSign(extra.seller, extra.buyer);
  extra.result.transaction.message = extra.built.transaction.compileMessage();
  extra.result.transaction.signatures = extra.built.transaction.signatures.map(entry => bs58.encode(entry.signature));
  const changedSignature = extra.result.transaction.signatures[0];
  extra.connection.getTransaction = async () => extra.result;
  extra.connection.getSignatureStatuses = async () => ({ context: { slot: SLOT }, value: [extra.status] });
  await assert.rejects(extra.verify({ signature: changedSignature }), { code: 'CANONICAL_TRANSACTION_MISMATCH' });
});

test('receipt rejects missing, duplicate, wrong-owner or wrong-amount NFT metadata', async () => {
  for (const mutate of [
    meta => { delete meta.preTokenBalances; },
    meta => { meta.postTokenBalances.push({ ...meta.postTokenBalances[1] }); },
    meta => { meta.postTokenBalances[1].owner = Keypair.generate().publicKey.toBase58(); },
    meta => { meta.postTokenBalances[1].uiTokenAmount.amount = '2'; },
    meta => { delete meta.postTokenBalances[1].programId; },
  ]) {
    const fixture = setup();fixture.finalizeOwnership();mutate(fixture.result.meta);
    await assert.rejects(fixture.verify());
  }
});

test('receipt rejects unsafe numeric values, incorrect SOL deltas, changed hashes and stale current ownership', async () => {
  for (const mutate of [
    fixture => { fixture.result.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1; },
    fixture => { fixture.result.meta.fee = 0.5; },
    fixture => { fixture.result.blockTime = null; },
    fixture => { fixture.result.meta.postBalances[0]++; },
  ]) {
    const fixture = setup();fixture.finalizeOwnership();mutate(fixture);
    await assert.rejects(fixture.verify());
  }
  const hash = setup();hash.finalizeOwnership();await assert.rejects(hash.verify({ expectedMessageSha256: '0'.repeat(64) }), { code: 'MESSAGE_HASH_MISMATCH' });
  const ownership = setup();await assert.rejects(ownership.verify(), { code: 'INVALID_TOKEN_ACCOUNT' });
});

test('receipt compares a supplied preflight without treating editable JSON as independent proof', async () => {
  const fixture = setup();const preflight = await preflightMainnetSale(fixture);fixture.finalizeOwnership();
  preflight.feeKey.originalLockOwner = Keypair.generate().publicKey.toBase58();
  await assert.rejects(fixture.verify({ preflight }), { code: 'LOCK_LINKAGE_CHANGED' });
});

test('a same-slot or later preflight cannot stand in for a before-sale observation', async () => {
  const fixture = setup();const preflight = await preflightMainnetSale(fixture);fixture.finalizeOwnership();
  preflight.snapshotSlot = SLOT;
  await assert.rejects(fixture.verify({ preflight }), { code: 'PREFLIGHT_MISMATCH' });
});

test('supplied preflight snapshot ordering cannot precede its own Fee Key verification', async () => {
  const fixture = setup();const preflight = await preflightMainnetSale(fixture);fixture.finalizeOwnership();
  preflight.snapshotSlot = preflight.feeKey.slot - 1;
  await assert.rejects(fixture.verify({ preflight }), { code: 'PREFLIGHT_MISMATCH' });
});
