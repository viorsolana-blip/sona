import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, decodeTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildSettlementTransaction, verifyCanonicalSignedTransaction, parseLamports,
  solToLamports, assertSettlementNotExpired, prepareSettlement, findExternalSettlement } from '../src/chain/settlement.mjs';

const seller = Keypair.generate();
const buyer = Keypair.generate();
const mint = Keypair.generate().publicKey;
const source = getAssociatedTokenAddressSync(mint, seller.publicKey);
const params = { seller: seller.publicKey, buyer: buyer.publicKey, mint,
  sourceTokenAccount: source, priceLamports: '1250000001',
  blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 };
const wire = (transaction) => transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');

test('prices preserve all nine SOL decimals and reject lossy numeric input', () => {
  assert.equal(solToLamports('1.250000001'), '1250000001');
  assert.equal(solToLamports('0.000000001'), '1');
  assert.equal(parseLamports('18446744073709551615'), 18446744073709551615n);
  for (const bad of [1, 1.5, '0', '-1', '1.0', '01', '1e9', ' 1', '18446744073709551616']) {
    assert.throws(() => parseLamports(bad), { code: 'INVALID_PRICE' });
  }
  for (const bad of ['0', '1.0000000001', 1.1, '01', '1e2', '.2']) assert.throws(() => solToLamports(bad));
});

test('canonical sale contains only ATA creation, one checked NFT transfer, and exact SOL payment', () => {
  const built = buildSettlementTransaction(params);
  const tx = built.transaction;
  assert.equal(tx.instructions.length, 3);
  assert(tx.instructions[0].programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert(tx.instructions[1].programId.equals(TOKEN_PROGRAM_ID));
  assert(tx.instructions[2].programId.equals(SystemProgram.programId));
  const transfer = decodeTransferCheckedInstruction(tx.instructions[1]);
  assert.equal(transfer.data.amount, 1n);
  assert.equal(transfer.data.decimals, 0);
  assert(transfer.keys.owner.pubkey.equals(seller.publicKey));
  assert(transfer.keys.source.pubkey.equals(source));
  assert(transfer.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(mint, buyer.publicKey)));
  assert(tx.feePayer.equals(buyer.publicKey));
  assert.deepEqual(tx.compileMessage().accountKeys.slice(0, 2).map(String), [buyer.publicKey.toBase58(), seller.publicKey.toBase58()]);
  assert.equal(tx.compileMessage().header.numRequiredSignatures, 2);
  assert(tx.instructions[2].keys[0].pubkey.equals(buyer.publicKey));
  assert(tx.instructions[2].keys[1].pubkey.equals(seller.publicKey));
  assert.equal(tx.instructions[2].data.readBigUInt64LE(4), 1250000001n);
});

test('seller partial signature survives the buyer signature and both are required', () => {
  const built = buildSettlementTransaction(params);
  built.transaction.partialSign(seller);
  const partial = verifyCanonicalSignedTransaction({ transactionBase64: wire(built.transaction),
    expectedTransactionBase64: built.transactionBase64, requiredSigners: [seller.publicKey] });
  assert.deepEqual(partial.signedBy, [seller.publicKey.toBase58()]);
  assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: partial.transactionBase64,
    expectedTransactionBase64: built.transactionBase64, requiredSigners: [buyer.publicKey, seller.publicKey] }), { code: 'MISSING_SIGNATURE' });
  const buyerTx = Transaction.from(Buffer.from(partial.transactionBase64, 'base64'));
  buyerTx.partialSign(buyer);
  const final = verifyCanonicalSignedTransaction({ transactionBase64: wire(buyerTx), expectedTransactionBase64: built.transactionBase64,
    requiredSigners: [buyer.publicKey, seller.publicKey] });
  assert.equal(final.signedBy.length, 2);
  assert(final.transaction.verifySignatures(true));
});

test('price, recipient, fee payer, NFT, source and blockhash tampering are rejected even when re-signed', () => {
  const expected = buildSettlementTransaction(params);
  const replacements = [
    { priceLamports: '1' }, { buyer: Keypair.generate().publicKey },
    { seller: Keypair.generate().publicKey }, { mint: Keypair.generate().publicKey },
    { sourceTokenAccount: Keypair.generate().publicKey }, { blockhash: Keypair.generate().publicKey.toBase58() },
  ];
  for (const replacement of replacements) {
    const altered = buildSettlementTransaction({ ...params, ...replacement });
    assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: altered.transactionBase64,
      expectedTransactionBase64: expected.transactionBase64 }), { code: 'TRANSACTION_CHANGED' });
  }
  const injected = expected.transaction;
  injected.add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1n }));
  assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: wire(injected),
    expectedTransactionBase64: expected.transactionBase64 }), { code: 'TRANSACTION_CHANGED' });
});

test('forged and wrong-wallet signatures are rejected', () => {
  const built = buildSettlementTransaction(params);
  built.transaction.partialSign(seller);
  built.transaction.signatures.find((entry) => entry.publicKey.equals(seller.publicKey)).signature[0] ^= 255;
  assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: wire(built.transaction),
    expectedTransactionBase64: built.transactionBase64, requiredSigners: [seller.publicKey] }), { code: 'INVALID_SIGNATURE' });
  const wrong = Keypair.generate();
  assert.throws(() => buildSettlementTransaction(params).transaction.partialSign(wrong), /unknown signer/);
});

test('self trade, expired requests, malformed encodings and invalid lifetimes fail closed', async () => {
  assert.throws(() => buildSettlementTransaction({ ...params, buyer: seller.publicKey }), { code: 'SELF_TRADE' });
  assert.throws(() => buildSettlementTransaction({ ...params, lastValidBlockHeight: -1 }), { code: 'INVALID_EXPIRY' });
  const built = buildSettlementTransaction(params);
  for (const malformed of ['', 'abc', 'not-base64!', built.transactionBase64 + '\n']) {
    assert.throws(() => verifyCanonicalSignedTransaction({ transactionBase64: malformed,
      expectedTransactionBase64: built.transactionBase64 }), { code: 'INVALID_TRANSACTION' });
  }
  await assert.rejects(assertSettlementNotExpired({ connection: { getBlockHeight: async () => 1001 }, lastValidBlockHeight: 1000 }), { code: 'SETTLEMENT_EXPIRED' });
  assert.equal(await assertSettlementNotExpired({ connection: { getBlockHeight: async () => 1000 }, lastValidBlockHeight: 1000 }), 1000);
});

test('prepare refuses missing/failed Raydium verification before preparing any transaction', async () => {
  const listing = params;
  await assert.rejects(prepareSettlement({ connection: {}, listing, buyer: buyer.publicKey }), { code: 'VERIFIER_REQUIRED' });
  await assert.rejects(prepareSettlement({ connection: {}, listing, buyer: buyer.publicKey,
    verifyFeeKey: async () => ({ verified: false }) }), { code: 'UNVERIFIED_FEE_KEY' });
  await assert.rejects(prepareSettlement({ connection: {}, listing, buyer: buyer.publicKey,
    verifyFeeKey: async () => ({ verified: true, mint: Keypair.generate().publicKey }) }), { code: 'UNVERIFIED_FEE_KEY' });
});

function externalFixture(replacement = {}) {
  const built = buildSettlementTransaction({ ...params, ...replacement });
  built.transaction.partialSign(seller, buyer);
  const signatures = built.transaction.signatures.map(({ signature }) => bs58.encode(signature));
  return { built, signature: signatures[0], result: { slot: 500, meta: { err: null },
    transaction: { message: built.transaction.compileMessage(), signatures } } };
}

test('external receipt recovery finds only finalized exact canonical transactions with both valid signatures', async () => {
  const good = externalFixture();
  const changedPrice = externalFixture({ priceLamports: '1' });
  const seen = [];
  const connection = {
    async getSignaturesForAddress(key, options, commitment) {
      assert(key.equals(source)); assert.deepEqual(options, { limit: 100 }); assert.equal(commitment, 'finalized');
      return [{ signature: changedPrice.signature, err: null, blockTime: 200 }, { signature: good.signature, err: null, blockTime: 200 }];
    },
    async getTransaction(signature, options) {
      seen.push(signature); assert.equal(options.commitment, 'finalized');
      return signature === good.signature ? good.result : changedPrice.result;
    },
  };
  const recovered = await findExternalSettlement({ connection, settlement: good.built, notBeforeBlockTime: 150 });
  assert.deepEqual(recovered, { signature: good.signature, slot: 500, commitment: 'finalized', messageSha256: good.built.messageSha256 });
  assert.equal(seen.length, 2);
});

test('external receipt recovery ignores failed, missing, too-old and forged transactions', async () => {
  const good = externalFixture();
  const forgedSignatures = [...good.result.transaction.signatures];
  forgedSignatures[1] = bs58.encode(Buffer.alloc(64, 1));
  let queried = 0;
  for (const scenario of ['failed', 'missing', 'old', 'forged']) {
    const connection = {
      async getSignaturesForAddress() { return [{ signature: good.signature, err: scenario === 'failed' ? { InstructionError: [2, 'Custom'] } : null, blockTime: scenario === 'old' ? 1 : 200 }]; },
      async getTransaction() { queried++; return scenario === 'missing' ? null : { ...good.result,
        transaction: { ...good.result.transaction, signatures: forgedSignatures } }; },
    };
    assert.equal(await findExternalSettlement({ connection, settlement: good.built, notBeforeBlockTime: 150 }), null);
  }
  assert.equal(queried, 2);
});

test('bounded external scans propagate RPC errors and do not treat incomplete coverage as proof of absence', async () => {
  const good = externalFixture();
  await assert.rejects(findExternalSettlement({ connection: {}, settlement: good.built, limit: 101 }), { code: 'INVALID_SCAN_LIMIT' });
  await assert.rejects(findExternalSettlement({ connection: { getSignaturesForAddress: async () => { throw new Error('RPC unavailable'); } }, settlement: good.built }), /RPC unavailable/);
  await assert.rejects(findExternalSettlement({ connection: {}, settlement: { ...good.built, messageSha256: 'wrong' } }), { code: 'INVALID_CANONICAL_MESSAGE' });
  assert.equal(await findExternalSettlement({ connection: { getSignaturesForAddress: async () => [] }, settlement: good.built }), null);
});
