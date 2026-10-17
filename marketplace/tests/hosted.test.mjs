import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { D1Store } from '../src/hosted/d1-store.mjs';
import { HostedMarketplace } from '../src/hosted/marketplace.mjs';
import { handleApi } from '../src/hosted/http.mjs';
import { buildSettlementTransaction } from '../src/chain/settlement.mjs';
import { GENESIS_HASHES } from '../src/server/network.mjs';

// A deliberately small D1 API compatibility harness. Every batch executes in a
// real SQLite transaction. Cloudflare runtime checks are a separate release gate.
class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(readFileSync(new URL('../src/hosted/migration.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const database = this;
    return { sql, values: [], bind(...values) { return { ...this, values }; },
      async first(column) { const value = database.execute(this).results[0] || null; return column ? value?.[column] ?? null : value; },
      async all() { return database.execute(this); }, async run() { return database.execute(this); } };
  }
  execute({ sql, values }) {
    const statement = this.sqlite.prepare(sql), returns = statement.columns().length > 0;
    const results = returns ? statement.all(...values) : [];
    const changes = returns ? (/^SELECT/i.test(sql) ? 0 : this.sqlite.prepare('SELECT changes() AS n').get().n) : statement.run(...values).changes;
    return { results, success: true, meta: { changes: Number(changes) } };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(statement => this.execute(statement)); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}
function database(t) { const db = new SqliteD1(); t.after(() => db.close()); return db; }
const wire = transaction => transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
function gate() { let release, entered; const start = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve); return { start, release: value => release(value), pause: async () => { entered(); return wait; } }; }

async function fixture(t) {
  const db = database(t), store = new D1Store(db), seller = Keypair.generate(), buyer = Keypair.generate(), other = Keypair.generate();
  const s = seller.publicKey.toBase58(), b = buyer.publicKey.toBase58(), o = other.publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58(), tokenAccount = Keypair.generate().publicKey.toBase58();
  let now = Date.now(), height = 10, holder = s, status = null, sends = 0, inspections = 0, preparations = 0;
  const proof = { verified: true, mint, owner: s, tokenAccount, mintA: mint, mintB: mint, poolId: mint, lpMint: mint, slot: 8 };
  const connection = {
    getBlockHeight: async () => height,
    getSignatureStatuses: async () => ({ value: [status] }),
    getBalance: async () => 123,
    sendRawTransaction: async bytes => { sends++; return bs58.encode(Transaction.from(bytes).signature); },
  };
  const verifyFeeKey = async ({ owner, mint: value }) => {
    if (String(owner) !== holder || String(value) !== mint) { const error = new Error('Not held'); error.name = 'RaydiumEligibilityError'; error.code = 'NOT_HELD'; throw error; }
    return { ...proof, owner: String(owner) };
  };
  const options = { store, connection, origin: 'https://sona.example', cluster: 'mainnet-beta', genesisHash: GENESIS_HASHES['mainnet-beta'], now: () => now, verifyFeeKey, discoverFeeKeys: async () => ({ positions: [], rejected: [], slot: 8 }),
    settlement: {
      prepareSettlement: async ({ listing, buyer: owner }) => { preparations++; return buildSettlementTransaction({ ...listing, buyer: owner, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }); },
      inspectSettlementAsset: async () => { inspections++; },
      findExternalSettlement: async () => null,
    } };
  const market = await HostedMarketplace.create(options);
  return { db, store, options, market, connection, seller, buyer, other, s, b, o, mint, tokenAccount, proof,
    reset: async () => HostedMarketplace.create({ ...options, store: new D1Store(db) }),
    clock: value => now += value, height: value => height = value, holder: value => holder = value, status: value => status = value,
    sends: () => sends, preparations: () => preparations, inspections: () => inspections };
}
async function listed(f) { return (await f.market.createListing(f.s, { mint: f.mint, priceLamports: '500000001' })).listing; }
async function requested(f) { const listing = await listed(f), { trade } = await f.market.requestPurchase(f.b, listing.id); return { listing, trade }; }
async function approved(f) {
  const { listing, trade } = await requested(f), prepared = await f.market.prepare(f.s, trade.id);
  const tx = Transaction.from(Buffer.from(prepared.settlement.transactionBase64, 'base64')); tx.partialSign(f.seller);
  await f.market.approve(f.s, trade.id, wire(tx)); tx.partialSign(f.buyer);
  return { listing, trade, prepared, tx, wire: wire(tx) };
}
async function auth(market, wallet, challenge = null) {
  challenge ||= await market.challenge(wallet.publicKey.toBase58());
  return market.authenticate({ address: wallet.publicKey.toBase58(), challengeId: challenge.challengeId, signatureBase64: Buffer.from(nacl.sign.detached(Buffer.from(challenge.message), wallet.secretKey)).toString('base64') });
}

test('D1 revision batches serialize concurrent pure mutations and persist across instances', async t => {
  const db = database(t), a = new D1Store(db), b = new D1Store(db); await a.initialize();
  await a.put('counter', { id: 'one', value: 0 });
  await Promise.all([a, b, a].map(store => store.transaction(tx => { const value = tx.get('counter', 'one'); value.value++; tx.put('counter', value); })));
  assert.equal((await new D1Store(db).get('counter', 'one')).value, 3);
  await assert.rejects(a.transaction(tx => { tx.put('counter', { id: 'one', value: 99 }); throw Error('Stop'); }), /Stop/);
  assert.equal((await a.get('counter', 'one')).value, 3);
  await assert.rejects(a.transaction(async tx => { tx.put('counter', { id: 'one', value: 99 }); }), /synchronous/);
  assert.equal((await a.get('counter', 'one')).value, 3);
});

test('D1 stale revision guard rolls every later statement back', async t => {
  const db = database(t), store = new D1Store(db); await store.initialize();
  await store.put('listing', { id: 'one', status: 'active' });
  await assert.rejects(db.batch([
    store.statement("UPDATE sona_revisions SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id='marketplace'", 0),
    store.statement("UPDATE sona_records SET body=? WHERE kind='listing' AND id='one'", '{"id":"one","status":"sold"}'),
  ]), /NOT NULL/);
  assert.equal((await store.get('listing', 'one')).status, 'active');
});

test('wallet authentication consumes a challenge exactly once across Worker instances', async t => {
  const f = await fixture(t), other = await f.reset(), challenge = await f.market.challenge(f.s);
  await assert.rejects(auth(f.market, f.buyer, challenge), { code: 'CHALLENGE_EXPIRED' });
  const results = await Promise.allSettled([auth(f.market, f.seller, challenge), auth(other, f.seller, challenge)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const session = results.find(result => result.status === 'fulfilled').value;
  assert.equal(await other.session(session.token), f.s);
  const rows = f.db.sqlite.prepare('SELECT * FROM sona_sessions').all();
  assert.equal(rows.length, 1); assert.notEqual(rows[0].hash, session.token);
  await other.logout(session.token); assert.equal(await f.market.session(session.token), null);
  const expired = await f.market.challenge(f.s); f.clock(300001); await assert.rejects(auth(f.market, f.seller, expired), { code: 'CHALLENGE_EXPIRED' });
});

test('concurrent duplicate listings commit once and enforce signer ownership and integer prices', async t => {
  const f = await fixture(t), other = await f.reset();
  await assert.rejects(f.market.createListing(f.s, { mint: f.mint, priceLamports: 0.1 }), { code: 'INVALID_PRICE' });
  await assert.rejects(f.market.createListing(f.b, { mint: f.mint, priceLamports: '1' }), { code: 'NOT_HELD' });
  const results = await Promise.allSettled([f.market.createListing(f.s, { mint: f.mint, priceLamports: '1' }), other.createListing(f.s, { mint: f.mint, priceLamports: '1' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await f.store.all('listing')).length, 1);
  const listing = (await f.store.all('listing'))[0];
  await assert.rejects(other.changeListing(f.b, listing.id, {}, true), { code: 'NOT_OWNER' });
});

test('price changes invalidate requests and new owners can replace stale listings', async t => {
  const f = await fixture(t), { listing, trade } = await requested(f);
  assert.equal((await f.market.requestPurchase(f.b, listing.id)).trade.id, trade.id);
  await f.market.changeListing(f.s, listing.id, { priceLamports: '600000001' });
  assert.equal((await f.store.get('trade', trade.id)).status, 'canceled');
  assert.equal((await f.market.requestPurchase(f.b, listing.id)).trade.priceLamports, '600000001');
  f.holder(f.b);
  const replacement = await f.market.createListing(f.b, { mint: f.mint, priceLamports: '700000001' });
  assert.equal(replacement.listing.seller, f.b);
  assert.equal((await f.store.get('listing', listing.id)).status, 'expired');
});

test('two buyers cannot both reserve one Fee Key and preparation performs no retryable RPC', async t => {
  const f = await fixture(t), { listing, trade } = await requested(f), other = await f.reset();
  const second = (await other.requestPurchase(f.o, listing.id)).trade;
  const result = await Promise.allSettled([f.market.prepare(f.s, trade.id), other.prepare(f.s, second.id)]);
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(f.preparations(), 1);
  assert.equal((await f.store.get('listing', listing.id)).status, 'reserved');
});

test('new Worker requests preserve active preparation; expired leases recover without releasing signatures', async t => {
  const f = await fixture(t), { listing, trade } = await requested(f), pause = gate();
  const prepare = f.market.settlement.prepareSettlement;
  f.market.settlement.prepareSettlement = async args => { await pause.pause(); return prepare(args); };
  const operation = f.market.prepare(f.s, trade.id); await pause.start;
  const other = await f.reset();
  assert.equal((await other.getTrade(trade.id, f.s)).status, 'preparing');
  await other.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.get('listing', listing.id)).status, 'reserved');
  f.clock(60001); await other.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.get('trade', trade.id)).status, 'failed');
  assert.equal((await f.store.get('listing', listing.id)).status, 'active');
  pause.release(); await assert.rejects(operation, { code: 'TRADE_STATE' });
});

test('cancel racing seller approval prevents any released approval from entering durable state', async t => {
  const f = await fixture(t), { trade } = await requested(f), prepared = await f.market.prepare(f.s, trade.id);
  const tx = Transaction.from(Buffer.from(prepared.settlement.transactionBase64, 'base64')); tx.partialSign(f.seller);
  const pause = gate(), verify = f.market.verifyFeeKey;
  f.market.verifyFeeKey = async args => { await pause.pause(); return verify(args); };
  const pending = f.market.approve(f.s, trade.id, wire(tx)); await pause.start;
  await (await f.reset()).cancel(f.b, trade.id); pause.release();
  await assert.rejects(pending, { code: 'TRADE_STATE' });
  const stored = await f.store.get('trade', trade.id); assert.equal(stored.status, 'canceled'); assert.equal(stored.approvedTransaction, undefined);
});

test('signed approval is immutable, participant-protected, and cannot be revoked by a cosmetic cancel', async t => {
  const f = await fixture(t), { listing, trade, tx } = await approved(f);
  await assert.rejects(f.market.cancel(f.b, trade.id), { code: 'APPROVAL_RELEASED' });
  await assert.rejects(f.market.changeListing(f.s, listing.id, {}, true), { code: 'LISTING_UNAVAILABLE' });
  await assert.rejects(f.market.trade(f.o, trade.id), { code: 'NOT_PARTICIPANT' });
  tx.instructions[2].data.writeBigUInt64LE(1n, 4); tx.partialSign(f.seller, f.buyer);
  await assert.rejects(f.market.submit(f.b, trade.id, wire(tx)), { code: 'TRANSACTION_CHANGED' });
  assert.equal(f.sends(), 0);
});

test('submission persists exact signed bytes before broadcast and survives RPC timeout/restart', async t => {
  const f = await fixture(t), { trade, wire: signed } = await approved(f);
  let seenSignature;
  f.connection.sendRawTransaction = async bytes => {
    const stored = await new D1Store(f.db).get('trade', trade.id);
    assert.equal(stored.status, 'submitted'); assert.equal(stored.submittedTransaction, signed);
    seenSignature = bs58.encode(Transaction.from(bytes).signature); assert.equal(stored.signature, seenSignature);
    throw new Error('RPC response was lost');
  };
  const submitted = await f.market.submit(f.b, trade.id, signed); assert.equal(submitted.pending, true); assert.equal(submitted.signature, seenSignature);
  const restarted = await f.reset(); assert.equal((await restarted.getTrade(trade.id, f.b)).signature, seenSignature);
  f.status({ confirmationStatus: 'finalized', slot: 99, err: null }); f.clock(1001);
  const confirmed = await restarted.trade(f.b, trade.id); assert.equal(confirmed.trade.status, 'confirmed');
  await restarted.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.all('receipt')).length, 1);
  assert.equal((await f.store.all('activity')).filter(a => a.type === 'sale').length, 1);
});

test('concurrent finalization emits one receipt and stale expiry cannot reopen a sold listing', async t => {
  const f = await fixture(t), { trade, wire: signed, listing } = await approved(f); await f.market.submit(f.b, trade.id, signed);
  const snapshot = await f.store.get('trade', trade.id), other = await f.reset();
  const results = await Promise.all([f.market.complete(snapshot, 101), other.complete(snapshot, 101)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await f.market.finishPending(snapshot, 'expired'), false);
  assert.equal((await f.store.get('listing', listing.id)).status, 'sold'); assert.equal((await f.store.all('receipt')).length, 1);
});

test('confirmed transaction errors retain reservation until finalization', async t => {
  const f = await fixture(t), { trade, wire: signed, listing } = await approved(f); await f.market.submit(f.b, trade.id, signed);
  f.height(150); f.status({ confirmationStatus: 'confirmed', slot: 99, err: { InstructionError: [2, 'Custom'] } }); f.clock(1001);
  await f.market.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.get('trade', trade.id)).status, 'submitted'); assert.equal((await f.store.get('listing', listing.id)).status, 'reserved');
  f.status({ confirmationStatus: 'finalized', slot: 99, err: { InstructionError: [2, 'Custom'] } }); f.clock(1001);
  await f.market.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.get('trade', trade.id)).status, 'failed'); assert.equal((await f.store.all('receipt')).length, 0);
});

test('expired external approval checks ownership and never reopens another owner’s Fee Key', async t => {
  const f = await fixture(t), { trade, listing } = await approved(f);
  f.height(101); f.holder(f.o); f.clock(1001); await f.market.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.get('trade', trade.id)).status, 'expired'); assert.equal((await f.store.get('listing', listing.id)).status, 'unavailable');
});

test('database identity cannot cross networks and sessions expire across instances', async t => {
  const f = await fixture(t), session = await auth(f.market, f.seller);
  await assert.rejects(HostedMarketplace.create({ ...f.options, store: new D1Store(f.db), cluster: 'devnet', genesisHash: GENESIS_HASHES.devnet }), /another Solana network/);
  f.clock(3600001); assert.equal(await (await f.reset()).session(session.token), null);
});

test('live public verifier resolves holder on chain without creating listings or claiming PDA signing support', async t => {
  const f = await fixture(t), pda = PublicKey.findProgramAddressSync([Buffer.from('test')], TOKEN_PROGRAM_ID)[0]; f.holder(pda.toBase58());
  const data = Buffer.alloc(165); new PublicKey(f.mint).toBuffer().copy(data, 0); pda.toBuffer().copy(data, 32); data.writeBigUInt64LE(1n, 64); data[108] = 1;
  f.connection.getTokenLargestAccounts = async () => ({ context: { slot: 50 }, value: [{ address: new PublicKey(f.tokenAccount), amount: '1', decimals: 0 }] });
  f.connection.getAccountInfoAndContext = async () => ({ context: { slot: 50 }, value: { data, executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1 } });
  const result = await f.market.verifyMint(f.mint);
  assert.equal(result.verified, true); assert.equal(result.readOnly, true); assert.equal(result.signingFlowSupported, false);
  assert.equal((await f.store.all('listing')).length, 0); assert.equal(f.sends(), 0);
  f.connection.getTokenLargestAccounts = async () => { throw Error('RPC unavailable'); };
  await assert.rejects(f.market.verifyMint(f.mint), { code: 'HOLDER_LOOKUP_UNAVAILABLE' });
});

test('public verifier accepts an untrusted token-account hint only after live account and canonical checks', async t => {
  const f = await fixture(t), data = Buffer.alloc(165);
  new PublicKey(f.mint).toBuffer().copy(data, 0); f.seller.publicKey.toBuffer().copy(data, 32); data.writeBigUInt64LE(1n, 64); data[108] = 1;
  let verified = 0;
  f.connection.getTokenLargestAccounts = async () => { throw Error('Hint must not use the holder index'); };
  f.connection.getAccountInfoAndContext = async key => {
    assert.equal(key.toBase58(), f.tokenAccount);
    return { context: { slot: 77 }, value: { data, executable: false, owner: TOKEN_PROGRAM_ID, lamports: 1 } };
  };
  const verify = f.market.verifyFeeKey;
  f.market.verifyFeeKey = async options => { verified++; assert.equal(options.minContextSlot, 77); assert.equal(options.tokenAccount.toBase58(), f.tokenAccount); return verify(options); };
  const result = await f.market.verifyMint(f.mint, { tokenAccount: f.tokenAccount });
  assert.equal(result.verified, true); assert.equal(result.signingFlowSupported, true); assert.equal(verified, 1);
  assert.equal((await f.store.all('listing')).length, 0); assert.equal(f.sends(), 0);
});

test('token-account hints reject malformed addresses, wrong mints, wrong programs and executable accounts', async t => {
  const f = await fixture(t), data = Buffer.alloc(165);
  new PublicKey(f.mint).toBuffer().copy(data, 0); f.seller.publicKey.toBuffer().copy(data, 32); data.writeBigUInt64LE(1n, 64); data[108] = 1;
  let owner = TOKEN_PROGRAM_ID, executable = false, reads = 0, verified = 0;
  f.connection.getAccountInfoAndContext = async () => { reads++; return { context: { slot: 77 }, value: { data, executable, owner, lamports: 1 } }; };
  f.market.verifyFeeKey = async () => { verified++; return f.proof; };
  await assert.rejects(f.market.verifyMint(f.mint, { tokenAccount: 'invalid address!' }), { code: 'INVALID_TOKEN_ACCOUNT' }); assert.equal(reads, 0);
  f.other.publicKey.toBuffer().copy(data, 0);
  await assert.rejects(f.market.verifyMint(f.mint, { tokenAccount: f.tokenAccount }), { code: 'TOKEN_MINT_MISMATCH' });
  new PublicKey(f.mint).toBuffer().copy(data, 0); owner = f.other.publicKey;
  await assert.rejects(f.market.verifyMint(f.mint, { tokenAccount: f.tokenAccount }), { code: 'INVALID_TOKEN_ACCOUNT' });
  owner = TOKEN_PROGRAM_ID; executable = true;
  await assert.rejects(f.market.verifyMint(f.mint, { tokenAccount: f.tokenAccount }), { code: 'INVALID_TOKEN_ACCOUNT' });
  assert.equal(verified, 0);
});

test('HTTP API blocks cross-origin writes, unauthenticated actions and oversized JSON without exposing internals', async t => {
  const f = await fixture(t), origin = f.options.origin, request = (path, options = {}) => handleApi(new Request(origin + path, { headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.10', ...options.headers }, ...options }), { market: f.market, origin });
  assert.equal(await request('/app/'), null);
  const config = await request('/api/config'); assert.equal(config.status, 200); assert.equal((await config.json()).persistence, 'Cloudflare D1');
  assert.equal((await request('/api/listings', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await request('/api/auth/challenge', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://wrong.example' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/auth/challenge', { method: 'POST', body: JSON.stringify({ address: 'x'.repeat(20000) }) })).status, 413);
  assert.equal((await request('/api/auth/challenge', { method: 'POST', body: '[]' })).status, 400);
  const empty = await request('/api/receipts'); assert.deepEqual(await empty.json(), { receipts: [], total: 0 });
  f.market.verifyMint = async () => { throw new Error('secret transport detail'); };
  const failure = await request('/api/verify/' + f.mint); assert.equal(failure.status, 502); assert(!JSON.stringify(await failure.json()).includes('secret transport'));
});

test('rate limits persist across Worker instances and reset on the next minute', async t => {
  const db = database(t), a = new D1Store(db), b = new D1Store(db), time = 60000;
  assert.equal(await a.rateLimit('hashed-client', time, 2), true);
  assert.equal(await b.rateLimit('hashed-client', time, 2), true);
  assert.equal(await a.rateLimit('hashed-client', time, 2), false);
  for (let i = 0; i < 20; i++) assert.equal(await b.rateLimit('hashed-client', time, 2), false);
  assert.equal(db.sqlite.prepare('SELECT count FROM sona_limits WHERE key=?').get('hashed-client').count, 2);
  assert.equal(await b.rateLimit('hashed-client', time + 60000, 2), true);
});

test('unsigned request/cancel spam is pruned and cannot consume reserved receipt capacity', async t => {
  const f = await fixture(t); f.store.maxRecords = 40;
  const listing = await listed(f);
  for (let attempt = 0; attempt < 100; attempt++) {
    const { trade } = await f.market.requestPurchase(f.b, listing.id);
    await f.market.cancel(f.b, trade.id); f.clock(1);
  }
  assert((await f.store.all('trade')).length <= 4);
  assert((await f.store.all('activity')).length <= 13);
  const { trade } = await f.market.requestPurchase(f.b, listing.id), prepared = await f.market.prepare(f.s, trade.id);
  const tx = Transaction.from(Buffer.from(prepared.settlement.transactionBase64, 'base64')); tx.partialSign(f.seller);
  await f.market.approve(f.s, trade.id, wire(tx)); tx.partialSign(f.buyer);
  await f.market.submit(f.b, trade.id, wire(tx)); f.status({ confirmationStatus: 'finalized', slot: 42, err: null }); f.clock(1001);
  await f.market.reconcile({ tradeId: trade.id });
  assert.equal((await f.store.all('receipt')).length, 1);
  assert.equal((await f.store.get('listing', listing.id)).status, 'sold');
});

test('lightweight public endpoints avoid client-counter writes and reconcile is durably throttled', async t => {
  const f = await fixture(t), origin = f.options.origin;
  for (let i = 0; i < 5; i++) {
    await handleApi(new Request(origin + '/api/config'), { market: f.market, origin });
    await handleApi(new Request(origin + '/api/receipts'), { market: f.market, origin });
  }
  assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM sona_limits').get().n, 0);
  await f.market.listings(); const first = f.db.sqlite.prepare("SELECT count FROM sona_limits WHERE key='reconcile:marketplace'").get();
  await f.market.listings(); await f.market.listings();
  assert.equal(first.count, 1);
  assert.equal(f.db.sqlite.prepare("SELECT count FROM sona_limits WHERE key='reconcile:marketplace'").get().count, 1);
});
