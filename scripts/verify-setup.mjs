/** Public HTTP + chain reads only. This never authenticates, signs or sends a transaction. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyDeliveredDocument } from './verify-document.mjs';
import { assertQuoteMatches } from '../public/setup/state.mjs';

const origin = process.argv[2] || 'http://127.0.0.1:4180';
const output = process.argv[3] || '../work/setup-runtime.json';
const checks = [], documents = [];
// Unfunded public addresses generated for read-only testing; private material was discarded.
// These are never presented as user wallets, funding destinations or sale participants.
const input = { seller: 'VeFWndEokdniKGyidVgPvwoKu54Z9rzF8MxnPFUEGNs', buyer: 'BFX7vwibXyJN87XTWgpU4KmhfXSsdzGkk7N9mDXpaNFc', priceLamports: '1000' };
const request = (path, options = {}) => fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(45000) });
for (const path of ['/setup/', '/setup/index.html']) {
  const response = await request(path);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
  documents.push({ path, ...verifyDeliveredDocument(await response.text(), readFileSync('marketplace/dist/setup/index.html', 'utf8')) });
}
checks.push('Setup documents preserve authored HTML and enforce anti-framing headers');
const manifest = await (await request('/build-manifest.json')).json();
for (const [path, hash] of Object.entries(manifest.files)) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash, path);
checks.push('Deployed build manifest matches inspected source');
const quoteResponse = await request('/api/setup/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(input) });
const quote = await quoteResponse.json();
assert.equal(quoteResponse.status, 200, JSON.stringify(quote)); assertQuoteMatches(quote, input);
assert.equal(quote.creation.allInCostLamports, null); assert.equal(quote.creation.transactionFeesLamports, null);
assert.equal(quote.pool.address, '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4');
checks.push('Actual finalized SOL/USDC pool, balances and current rents read without signatures');
const foreign = await request('/api/setup/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.invalid' }, body: JSON.stringify(input) });
assert.equal(foreign.status, 403); checks.push('Foreign browser origin is rejected');
const invalid = await request('/api/setup/quote', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ ...input, rpcUrl: 'https://unrelated.invalid' }) });
assert.equal(invalid.status, 400); checks.push('Arbitrary RPC override is rejected');
assert.equal((await request('/api/setup/quote')).status, 405); checks.push('GET cannot start a cost check');
writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, executedAt: new Date().toISOString(), origin, deploymentSourceRevision: manifest.sourceRevision,
  scope: 'Read-only setup route, real mainnet account/rent observation and HTTP protections. No wallet ownership, wallet-extension session, sale, independent audit or customer activity is claimed.',
  transactionsSent: 0, fundsSpent: 0, checks, documents, sourceHashes: manifest.files, input, quote }, null, 2)}\n`);
console.log(JSON.stringify({ passed: checks.length, origin, slot: quote.pool.slot, output, transactionsSent: 0 }));
