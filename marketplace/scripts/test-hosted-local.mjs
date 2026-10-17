#!/usr/bin/env node
/** Hosted Request/Response API + D1-compatible SQLite + real local Solana execution. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { Transaction } from '@solana/web3.js';
import { getAccount } from '@solana/spl-token';
import { D1Store } from '../src/hosted/d1-store.mjs';
import { HostedMarketplace } from '../src/hosted/marketplace.mjs';
import { handleApi } from '../src/hosted/http.mjs';
import { inspectSettlementAsset } from '../src/chain/settlement.mjs';
import { runSettlementLocal } from './test-settlement-local.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wire = tx => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
class SqliteD1 {
  constructor(filename, migrate = false) { this.sqlite = new DatabaseSync(filename); if (migrate) this.sqlite.exec(readFileSync(join(root, 'src/hosted/migration.sql'), 'utf8')); }
  prepare(sql) {
    const database = this;
    return { sql, values: [], bind(...values) { return { ...this, values }; },
      async first(column) { const row = database.execute(this).results[0] || null; return column ? row?.[column] ?? null : row; },
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

await runSettlementLocal({ outputPath: join(root, 'evidence/hosted-settlement-local.json'), runBackend: async ({ connection, seller, buyer, other, nft }) => {
  const temporary = await mkdtemp(join(tmpdir(), 'sona-hosted-')), filename = join(temporary, 'd1-compatible.sqlite');
  const port = 42000 + Math.floor(Math.random() * 6000), origin = `http://127.0.0.1:${port}`;
  const asset = await nft(), mint = asset.mint.toBase58(), s = seller.publicKey.toBase58(), b = buyer.publicKey.toBase58();
  const genesisHash = await connection.getGenesisHash();
  // The production entrypoint never exposes dependency injection. This local
  // fixture tests the settlement system with a freshly created SPL NFT, not a
  // fabricated Raydium asset or a claim of a mainnet marketplace sale.
  const verify = async ({ owner, mint: requested }) => {
    assert.equal(String(requested), mint); await inspectSettlementAsset({ connection, ...asset, seller: owner });
    return { verified: true, mint, owner: String(owner), tokenAccount: asset.sourceTokenAccount.toBase58(), mintA: mint, mintB: mint, poolId: mint, lpMint: mint, slot: await connection.getSlot('confirmed') };
  };
  let db = new SqliteD1(filename, true), instances = 0;
  const makeMarket = async () => { instances++; return HostedMarketplace.create({ store: new D1Store(db), connection, cluster: 'localnet', genesisHash, origin, verifyFeeKey: verify, discoverFeeKeys: async ({ owner }) => ({ positions: [await verify({ owner, mint })], rejected: [], slot: await connection.getSlot() }) }); };
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const request = new Request(origin + req.url, { method: req.method, headers: { ...req.headers, 'cf-connecting-ip': '127.0.0.1' }, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const market = await makeMarket(), response = await handleApi(request, { market, origin });
      if (!response) { res.writeHead(404); res.end(); return; }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end('{"error":"Test adapter failed"}'); }
  });
  await new Promise(done => server.listen(port, '127.0.0.1', done));
  const cases = [];
  async function api(path, { method = 'GET', token, body, status = 200, headers = {} } = {}) {
    const response = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json(); assert.equal(response.status, status, JSON.stringify(result)); return result;
  }
  async function login(key) {
    const address = key.publicKey.toBase58(), challenge = await api('/api/auth/challenge', { method: 'POST', body: { address } });
    return (await api('/api/auth/verify', { method: 'POST', body: { address, challengeId: challenge.challengeId, signatureBase64: Buffer.from(nacl.sign.detached(Buffer.from(challenge.message), key.secretKey)).toString('base64') } })).token;
  }
  try {
    const sellerToken = await login(seller), buyerToken = await login(buyer), otherToken = await login(other);
    cases.push('Fresh wallet signatures authenticate across separate request instances');
    await api('/api/listings', { method: 'POST', body: { mint, priceLamports: '100000001' }, status: 401 });
    await api('/api/auth/challenge', { method: 'POST', body: { address: s }, headers: { Origin: 'https://attacker.invalid' }, status: 403 });
    cases.push('Unauthenticated and cross-origin mutations rejected');
    const { listing } = await api('/api/listings', { method: 'POST', token: sellerToken, body: { mint, priceLamports: '100000001', expiresInDays: 7 } });
    assert.equal((await api('/api/listings')).listings[0].id, listing.id);
    cases.push('Durable listing visible from a new request instance');
    const { trade } = await api(`/api/listings/${listing.id}/request`, { method: 'POST', token: buyerToken, body: {} });
    await api(`/api/trades/${trade.id}`, { token: otherToken, status: 403 });
    cases.push('Only trade participants can inspect signing payloads');
    const prepared = await api(`/api/trades/${trade.id}/prepare`, { method: 'POST', token: sellerToken, body: {} });
    const sellerTx = Transaction.from(Buffer.from(prepared.settlement.transactionBase64, 'base64')); sellerTx.partialSign(seller);
    await api(`/api/trades/${trade.id}/approve`, { method: 'POST', token: sellerToken, body: { transactionBase64: wire(sellerTx) } });
    await api(`/api/trades/${trade.id}/cancel`, { method: 'POST', token: sellerToken, body: {}, status: 409 });
    cases.push('Seller approval survives requests and cannot be falsely canceled');
    const approved = await api(`/api/trades/${trade.id}`, { token: buyerToken });
    const signed = Transaction.from(Buffer.from(approved.settlement.transactionBase64, 'base64')); signed.partialSign(buyer);
    const sellerBefore = await connection.getBalance(seller.publicKey), broadcast = connection.sendRawTransaction.bind(connection);
    connection.sendRawTransaction = async (bytes, options) => {
      const stored = await new D1Store(db).get('trade', trade.id);
      assert.equal(stored.status, 'submitted'); assert.equal(stored.submittedTransaction, wire(signed));
      await broadcast(bytes, options); throw new Error('Deliberately dropped RPC response after the real broadcast');
    };
    const submitted = await api(`/api/trades/${trade.id}/submit`, { method: 'POST', token: buyerToken, body: { transactionBase64: wire(signed) } });
    connection.sendRawTransaction = broadcast;
    assert.equal(submitted.pending, true);
    cases.push('Exact signed transaction persisted before actual broadcast; lost response remains pending');
    db.close(); db = new SqliteD1(filename);
    let completed;
    for (let attempt = 0; attempt < 80; attempt++) {
      completed = await api(`/api/trades/${trade.id}`, { token: buyerToken });
      if (completed.trade.status === 'confirmed') break;
      await new Promise(done => setTimeout(done, 500));
    }
    assert.equal(completed.trade.status, 'confirmed'); assert.equal(completed.trade.commitment, 'finalized');
    cases.push('Reopened persistent database and new request recover actual finalized transaction');
    assert.equal(await connection.getBalance(seller.publicKey) - sellerBefore, 100000001);
    assert.equal((await getAccount(connection, asset.sourceTokenAccount)).amount, 0n);
    assert.equal((await getAccount(connection, signed.instructions[1].keys[2].pubkey)).amount, 1n);
    cases.push('Exact 100000001-lamport payment and one NFT transfer on the local validator');
    const repeated = await api(`/api/trades/${trade.id}/submit`, { method: 'POST', token: buyerToken, body: { transactionBase64: wire(signed) } });
    assert.equal(repeated.signature, submitted.signature); assert.equal(await connection.getBalance(seller.publicKey) - sellerBefore, 100000001);
    assert.equal((await api('/api/receipts')).receipts.length, 1); assert.equal((await api('/api/listings')).listings.length, 0);
    cases.push('Repeat submission does not pay twice or duplicate the receipt');
    const receipt = (await new D1Store(db).all('receipt'))[0];
    const chainTransaction = await connection.getTransaction(receipt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    assert.equal(chainTransaction.meta.err, null); assert.equal(chainTransaction.slot, receipt.slot);
    cases.push('Durable public receipt matches actual finalized validator transaction');
    const sourceSha256 = {};
    for (const path of ['src/hosted/d1-store.mjs', 'src/hosted/marketplace.mjs', 'src/hosted/http.mjs', 'src/hosted/migration.sql', 'src/chain/settlement.mjs', 'scripts/test-hosted-local.mjs', 'tests/hosted.test.mjs']) sourceSha256[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
    const report = {
      schema: 'sona-hosted-local-evidence-v1', generatedAt: new Date().toISOString(), cluster: 'localnet', genesisHash,
      scope: 'Real HTTP requests through the hosted Request/Response API, D1-compatible real SQLite transactions, fresh marketplace instances per request, real local-validator SPL/System execution and durable restart recovery. This is not a Cloudflare D1 deployment test or a mainnet Raydium Fee Key sale. Raydium authenticity is tested separately against actual mainnet accounts.',
      privateKeysPersisted: false, requestInstances: instances, passed: cases.length, failed: 0, cases,
      mint, seller: s, buyer: b, priceLamports: '100000001', receipt,
      chainReceipt: { slot: chainTransaction.slot, error: chainTransaction.meta.err, feeLamports: chainTransaction.meta.fee, logMessages: chainTransaction.meta.logMessages, preTokenBalances: chainTransaction.meta.preTokenBalances, postTokenBalances: chainTransaction.meta.postTokenBalances },
      sourceSha256,
    };
    await writeFile(join(root, 'evidence/hosted-local.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ hostedPassed: report.passed, signature: receipt.signature, requestInstances: instances }));
  } finally {
    await new Promise(done => server.close(done)); db.close(); await rm(temporary, { recursive: true, force: true });
  }
} });
