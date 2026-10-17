import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { handleApi } from '../src/hosted/http.mjs';
import { SetupQuoteError } from '../src/setup/quote.mjs';

// These are in-memory public-address fixtures only. No wallet is connected,
// no signature is produced, and no request reaches an actual RPC service.
const ORIGIN = 'https://sona.example';
const publicTerms = () => ({ seller: Keypair.generate().publicKey.toBase58(), buyer: Keypair.generate().publicKey.toBase58() });
function fixture({ setupQuote, rate = () => true } = {}) {
  const calls = { quotes: [], rate: [], sessions: [], rpc: [], mutations: [] };
  const forbidden = name => (...args) => { calls.mutations.push({ name, args }); throw new Error(`${name} must not be called by a public cost check`); };
  const store = {
    async rateLimit(...args) { calls.rate.push(args); return rate(...args); },
    put: forbidden('store.put'), transaction: forbidden('store.transaction'),
    createChallenge: forbidden('store.createChallenge'), consumeChallenge: forbidden('store.consumeChallenge'), logout: forbidden('store.logout'),
  };
  const connection = {
    async getGenesisHash() { calls.rpc.push('getGenesisHash'); throw new Error('A malformed request must not reach RPC'); },
    sendRawTransaction: forbidden('sendRawTransaction'), sendTransaction: forbidden('sendTransaction'), requestAirdrop: forbidden('requestAirdrop'),
  };
  const market = { store, connection, async session(token) { calls.sessions.push(token); return null; } };
  for (const name of ['challenge', 'authenticate', 'logout', 'createListing', 'requestPurchase', 'changeListing', 'prepare', 'approve', 'submit', 'cancel']) market[name] = forbidden(`market.${name}`);
  const invoke = async (input = publicTerms(), options = {}) => {
    const headers = { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.44', ...(options.headers || {}) };
    const method = options.method || 'POST';
    const request = new Request(options.url || ORIGIN + '/api/setup/quote', {
      method, headers, ...(!['GET', 'HEAD'].includes(method) ? { body: options.rawBody ?? JSON.stringify(input) } : {}),
    });
    return handleApi(request, {
      market, origin: ORIGIN,
      ...(setupQuote ? { setupQuote: async args => { calls.quotes.push(args); return setupQuote(args); } } : {}),
    });
  };
  return { calls, market, connection, invoke };
}

test('public setup quote requires no session and cannot invoke signing, trade or authentication writes', async () => {
  const terms = publicTerms();
  const result = { kind: 'sona-setup-quote', readOnly: true, networkWrites: 0, transactionsSent: 0, creation: { allInCostLamports: null } };
  const f = fixture({ setupQuote: async ({ input, connection }) => {
    assert.deepEqual(input, terms); assert.equal(connection, f.connection); return result;
  } });
  const response = await f.invoke(terms);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), result);
  assert.equal(f.calls.quotes.length, 1); assert.deepEqual(f.calls.sessions, [undefined]);
  assert.deepEqual(f.calls.rpc, []); assert.deepEqual(f.calls.mutations, []);
  // Rate-limit counters are expected service writes, never listing/trade writes.
  assert.equal(f.calls.rate.length, 2);
  assert.match(f.calls.rate[0][0], /^[a-f0-9]{64}$/);
  assert.equal(f.calls.rate[1][0], `setup:${f.calls.rate[0][0]}`);
  assert.deepEqual(f.calls.rate[1].slice(2), [6, 60_000]);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('setup quotes reject foreign host, browser origin and cross-site requests before quota or RPC', async () => {
  for (const options of [
    { url: 'https://unrelated.example/api/setup/quote', expected: 400, code: 'HOST_MISMATCH' },
    { headers: { origin: 'https://unrelated.example' }, expected: 403, code: 'ORIGIN_MISMATCH' },
    { headers: { origin: 'null' }, expected: 403, code: 'ORIGIN_MISMATCH' },
    { headers: { 'sec-fetch-site': 'cross-site' }, expected: 403, code: 'ORIGIN_MISMATCH' },
  ]) {
    const f = fixture({ setupQuote: async () => assert.fail('No quote expected') });
    const response = await f.invoke(publicTerms(), options);
    assert.equal(response.status, options.expected); assert.equal((await response.json()).error.code, options.code);
    assert.deepEqual(f.calls.rate, []); assert.deepEqual(f.calls.rpc, []); assert.deepEqual(f.calls.mutations, []);
  }
});

test('setup route permits POST only and preserves JSON type, shape and size guards', async () => {
  for (const options of [
    { method: 'GET', expected: 405, code: 'METHOD' },
    { method: 'HEAD', expected: 405, code: 'METHOD' },
    { method: 'PUT', expected: 405, code: 'METHOD' },
    { method: 'DELETE', expected: 405, code: 'METHOD' },
    { headers: { 'content-type': 'text/plain' }, expected: 415, code: 'JSON_REQUIRED' },
    { rawBody: '{', expected: 400, code: 'INVALID_JSON' },
    { rawBody: '[]', expected: 400, code: 'INVALID_JSON' },
    { rawBody: 'null', expected: 400, code: 'INVALID_JSON' },
    { rawBody: JSON.stringify({ privateKey: 'x'.repeat(16_384) }), expected: 413, code: 'BODY_TOO_LARGE' },
    { headers: { 'content-length': '16385' }, expected: 413, code: 'BODY_TOO_LARGE' },
  ]) {
    const f = fixture({ setupQuote: async () => assert.fail('No quote expected') });
    const response = await f.invoke(publicTerms(), options);
    assert.equal(response.status, options.expected); assert.equal((await response.json()).error.code, options.code);
    assert.deepEqual(f.calls.quotes, []); assert.deepEqual(f.calls.rpc, []); assert.deepEqual(f.calls.mutations, []);
  }
});

test('six-per-minute setup quota is distinct from and subordinate to the shared client quota', async () => {
  const counts = new Map();
  const f = fixture({ setupQuote: async () => ({ readOnly: true }), rate(key, _now, maximum = 120) {
    const n = (counts.get(key) || 0) + 1; counts.set(key, n); return n <= maximum;
  } });
  for (let n = 0; n < 6; n++) assert.equal((await f.invoke()).status, 200);
  const limited = await f.invoke(); assert.equal(limited.status, 429); assert.equal((await limited.json()).error.code, 'RATE_LIMIT');
  assert.equal(f.calls.quotes.length, 6); assert.deepEqual(f.calls.mutations, []);
  const sharedLimit = fixture({ setupQuote: async () => assert.fail('Shared limit must short-circuit'), rate: () => false });
  assert.equal((await sharedLimit.invoke()).status, 429);
  assert.equal(sharedLimit.calls.rate.length, 1); assert.deepEqual(sharedLimit.calls.sessions, []);
});

test('unknown upstream exception messages, codes and status values are redacted', async () => {
  const f = fixture({ setupQuote: async () => { throw Object.assign(new Error('private provider URL https://rpc.invalid/secret-token'), { code: 'SECRET_UPSTREAM_CODE', status: 418 }); } });
  const response = await f.invoke(); const text = await response.text();
  assert.equal(response.status, 502); assert.equal(JSON.parse(text).error.code, 'UPSTREAM_UNAVAILABLE');
  assert.doesNotMatch(text, /secret|private provider|rpc\.invalid|SECRET_UPSTREAM_CODE/i);
  assert.deepEqual(f.calls.mutations, []);
});

test('known setup validation errors retain their safe actionable status and code', async () => {
  const f = fixture({ setupQuote: async () => { throw new SetupQuoteError('INVALID_SETUP_ACCOUNT', 'Suggested pool layout is unsupported.', 422); } });
  const response = await f.invoke(); assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_SETUP_ACCOUNT', message: 'Suggested pool layout is unsupported.' } });
});

test('real setup input validation rejects secrets, arbitrary endpoints and malformed addresses before RPC', async () => {
  const terms = publicTerms();
  for (const input of [
    {}, { ...terms, privateKey: 'SECRET_MUST_NOT_LEAVE_REQUEST' }, { ...terms, seedPhrase: 'SECRET_MUST_NOT_LEAVE_REQUEST' },
    { ...terms, rpcUrl: 'https://rpc.invalid/SECRET_MUST_NOT_LEAVE_REQUEST' }, { ...terms, poolId: terms.seller },
    { ...terms, buyer: terms.seller }, { ...terms, seller: 'invalid!' }, { ...terms, buyer: 123 },
    { ...terms, feeKeyMint: null }, { ...terms, feeKeyMint: terms.seller },
    { ...terms, priceLamports: 1 }, { ...terms, priceLamports: '0' }, { ...terms, priceLamports: '01' },
  ]) {
    const f = fixture(); const response = await f.invoke(input); const text = await response.text();
    assert.equal(response.status, 400, text); assert.doesNotMatch(text, /SECRET_MUST_NOT_LEAVE_REQUEST|rpc\.invalid/);
    assert.deepEqual(f.calls.rpc, []); assert.deepEqual(f.calls.mutations, []);
  }
});
