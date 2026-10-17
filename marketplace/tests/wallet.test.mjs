import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { createWalletController, bytesToBase64, base64ToBytes, shortAddress, assertAuthenticationChallenge } from '../src/client/wallet.mjs';

function injectedWallet(key = Keypair.generate()) {
  const listeners = new Map();
  const provider = {
    isPhantom: true, publicKey: key.publicKey,
    async connect() { return { publicKey: key.publicKey }; },
    async disconnect() {},
    async signMessage() { return { signature: new Uint8Array(64).fill(1) }; },
    async signTransaction(tx) { tx.partialSign(key); return tx; },
    on(name, handler) { listeners.set(name, handler); },
    removeListener(name) { listeners.delete(name); },
  };
  return { key, provider, listeners };
}
const registry = { get: () => [] };
const controller = (wallet, options = {}) => createWalletController({ host: { phantom: { solana: wallet.provider } }, registry, ...options });

test('wallet connection starts empty and uses an injected public key, not stored state', async () => {
  const wallet = injectedWallet(), changes = [];
  const client = controller(wallet, { onChange: value => changes.push(value) });
  assert.equal(client.address, null);
  assert.deepEqual(client.list().map(item => item.name), ['Phantom']);
  await client.connect('injected:Phantom');
  assert.equal(client.address, wallet.key.publicKey.toBase58());
  assert.equal(changes.at(-1).connected, true);
  const replacement = Keypair.generate().publicKey;
  wallet.listeners.get('accountChanged')(replacement);
  assert.equal(client.address, replacement.toBase58());
  await client.disconnect();
  assert.equal(client.address, null);
  assert.equal(wallet.listeners.size, 0);
});

test('a missing extension never opens a pretend connected account', async () => {
  const client = createWalletController({ host: {}, registry });
  await assert.rejects(client.connect('injected:Phantom'), /not available/);
  assert.equal(client.address, null);
  await assert.rejects(client.signMessage('hello'), /Connect your wallet/);
});

test('an account switch invalidates an in-flight message signature', async () => {
  const wallet = injectedWallet();
  let complete;
  wallet.provider.signMessage = () => new Promise(resolve => { complete = resolve; });
  const client = controller(wallet);
  await client.connect('injected:Phantom');
  const pending = client.signMessage('Sona login challenge');
  wallet.listeners.get('accountChanged')(Keypair.generate().publicKey);
  complete({ signature: new Uint8Array(64) });
  await assert.rejects(pending, /account changed/);
});

function unsignedTrade(seller, buyer) {
  const tx = new Transaction({ feePayer: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() });
  tx.add(SystemProgram.transfer({ fromPubkey: seller.publicKey, toPubkey: buyer.publicKey, lamports: 1 }));
  return tx;
}

test('seller and buyer sign the same immutable transaction and preserve both signatures', async () => {
  const seller = injectedWallet(), buyer = injectedWallet();
  const sellerClient = controller(seller), buyerClient = controller(buyer);
  await sellerClient.connect('injected:Phantom');
  await buyerClient.connect('injected:Phantom');
  const tx = unsignedTrade(seller.key, buyer.key);
  const initial = bytesToBase64(tx.serialize({ requireAllSignatures: false }));
  const partial = await sellerClient.signTransaction(initial);
  const final = await buyerClient.signTransaction(partial);
  const result = Transaction.from(base64ToBytes(final));
  assert.equal(result.verifySignatures(true), true);
  assert.deepEqual(result.serializeMessage(), tx.serializeMessage());
});

test('wallet-side transaction mutation is rejected before any broadcast', async () => {
  const wallet = injectedWallet(), buyer = Keypair.generate();
  wallet.provider.signTransaction = async tx => {
    tx.instructions[0] = SystemProgram.transfer({ fromPubkey: wallet.key.publicKey, toPubkey: buyer.publicKey, lamports: 900000000 });
    tx.partialSign(wallet.key);
    return tx;
  };
  const client = controller(wallet);
  await client.connect('injected:Phantom');
  const tx = unsignedTrade(wallet.key, buyer);
  await assert.rejects(client.signTransaction(bytesToBase64(tx.serialize({ requireAllSignatures: false }))), /changed the transaction/);
});

test('buyer wallet cannot silently discard the seller signature', async () => {
  const seller = injectedWallet(), buyer = injectedWallet();
  const transaction = unsignedTrade(seller.key, buyer.key);
  transaction.partialSign(seller.key);
  buyer.provider.signTransaction = async tx => {
    tx.signatures.find(item => item.publicKey.equals(seller.key.publicKey)).signature = null;
    tx.partialSign(buyer.key);
    return tx;
  };
  const client = controller(buyer);
  await client.connect('injected:Phantom');
  await assert.rejects(client.signTransaction(bytesToBase64(transaction.serialize({ requireAllSignatures: false }))), /existing transaction signature/);
});

test('invalid incoming seller signatures are rejected before the buyer wallet opens', async () => {
  const seller = injectedWallet(), buyer = injectedWallet();
  const transaction = unsignedTrade(seller.key, buyer.key);
  transaction.partialSign(seller.key);
  transaction.signatures.find(item => item.publicKey.equals(seller.key.publicKey)).signature[0] ^= 1;
  let prompts = 0;
  buyer.provider.signTransaction = async tx => { prompts++; return tx; };
  const client = controller(buyer);
  await client.connect('injected:Phantom');
  await assert.rejects(client.signTransaction(bytesToBase64(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }))), /invalid existing signature/);
  assert.equal(prompts, 0);
});

function authenticationChallenge({ address, origin = 'http://127.0.0.1:4173', cluster = 'mainnet-beta', now = Date.now() }) {
  return { challengeId: '11111111-1111-4111-8111-111111111111', message: `Sona wallet authentication\nOrigin: ${origin}\nNetwork: ${cluster}\nWallet: ${address}\nNonce: ${'ab'.repeat(24)}\nIssued at: ${new Date(now).toISOString()}\nExpires at: ${new Date(now + 300_000).toISOString()}\n\nAuthenticate this wallet with Sona. This message does not authorize an asset transfer.` };
}

test('authentication accepts only a fresh Sona message bound to this origin, cluster and wallet', () => {
  const options = { address: Keypair.generate().publicKey.toBase58(), origin: 'http://127.0.0.1:4173', cluster: 'mainnet-beta', now: Date.now() };
  const challenge = authenticationChallenge(options);
  assert.equal(assertAuthenticationChallenge(challenge, options), true);
  for (const changed of [
    authenticationChallenge({ ...options, origin: 'https://another-service.example' }),
    authenticationChallenge({ ...options, cluster: 'devnet' }),
    authenticationChallenge({ ...options, address: Keypair.generate().publicKey.toBase58() }),
    authenticationChallenge({ ...options, now: options.now - 300_001 }),
    authenticationChallenge({ ...options, now: options.now + 60_001 }),
    { ...challenge, message: challenge.message + '\nApprove an order on another service.' },
    { ...challenge, message: challenge.message.replace('Authenticate this wallet with Sona.', 'Transfer my Fee Key.') },
  ]) assert.throws(() => assertAuthenticationChallenge(changed, options));
});

test('Wallet Standard is used when Solana partial signing is supported', async () => {
  const key = Keypair.generate();
  const account = { address: key.publicKey.toBase58(), publicKey: key.publicKey.toBytes(), chains: ['solana:mainnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
  const wallet = { name: 'Standard wallet', chains: ['solana:mainnet'], features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signMessage': { signMessage: async input => [{ signedMessage: input.message, signature: new Uint8Array(64) }] },
    'solana:signTransaction': { signTransaction: async input => { const tx = Transaction.from(input.transaction); tx.partialSign(key); return [{ signedTransaction: tx.serialize({ requireAllSignatures: false }) }]; } },
  } };
  const client = createWalletController({ host: {}, registry: { get: () => [wallet] } });
  await client.connect('standard:Standard wallet');
  assert.equal(client.address, account.address);
  assert.equal(base64ToBytes(await client.signMessage('Sona login')).length, 64);
  assert.equal(shortAddress(account.address), `${account.address.slice(0, 4)}…${account.address.slice(-4)}`);
});

test('configured devnet is requested explicitly from a standard wallet', async () => {
  const key = Keypair.generate(), other = Keypair.generate();
  const account = { address: key.publicKey.toBase58(), publicKey: key.publicKey.toBytes(), chains: ['solana:devnet'], features: ['solana:signMessage', 'solana:signTransaction'] };
  let requestedChain;
  const standard = { name: 'Devnet wallet', chains: ['solana:devnet'], features: {
    'standard:connect': { connect: async () => ({ accounts: [account] }) },
    'solana:signMessage': { signMessage: async input => [{ signedMessage: input.message, signature: new Uint8Array(64) }] },
    'solana:signTransaction': { signTransaction: async input => { requestedChain = input.chain; const tx = Transaction.from(input.transaction); tx.partialSign(key); return [{ signedTransaction: tx.serialize({ requireAllSignatures: false }) }]; } },
  } };
  const client = createWalletController({ host: {}, registry: { get: () => [standard] } });
  assert.equal(client.list().length, 0);
  client.setChain('devnet');
  await client.connect('standard:Devnet wallet');
  await client.signTransaction(bytesToBase64(unsignedTrade(key, other).serialize({ requireAllSignatures: false })));
  assert.equal(requestedChain, 'solana:devnet');
  client.setChain('mainnet-beta');
  assert.equal(client.address, null);
});

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { assertSettlementTransaction } from '../src/client/wallet.mjs';
import { buildSettlementTransaction } from '../src/chain/settlement.mjs';

// Actual browser state/actions with isolated DOM and API doubles. Test inputs
// remain in this file; they are never shipped as marketplace positions.
function uiHarness(routes = async () => ({})) {
  const elements = new Map(), handlers = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, disabled: false, isConnected: true, dataset: {}, innerHTML: '', children: [], classList: { add() {}, remove() {}, contains() { return false; } }, setAttribute() {}, removeAttribute() {}, focus() {}, contains() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; } });
    return elements.get(id);
  };
  const fakeWallet = { address: null, setChain() {}, list() { return []; }, async signMessage() { return ''; }, async signTransaction(tx) { return tx; } };
  const document = { activeElement: null, body: element('body'), querySelector: element, querySelectorAll: () => [], addEventListener(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); } };
  const context = vm.createContext({ document, console, URL, Date, BigInt, Intl, Map, Set, crypto: { randomUUID: () => 'id' }, window: { addEventListener() {}, scrollTo() {} }, localStorage: { getItem: () => JSON.stringify({ balance: 125, positions: [{ id: 'old-fictional-position' }] }), setItem() {} }, location: { origin: 'http://127.0.0.1:4173', pathname: '/app/', hash: '' }, createWalletController: () => fakeWallet, shortAddress, assertSettlementTransaction, assertAuthenticationChallenge, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}, fetch: async (path, options) => { requests.push({ path, options });const result = await routes(path, options);return { ok: result.status ? result.status < 400 : true, status: result.status || 200, json: async () => result.body || result }; } });
  const source = readFileSync(new URL('../dist/app/app.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '').replace(/render\(\);mountIcons\(\);refreshData\(\).then\(hashDeal\);\nsetInterval[^\n]+\n?$/, '');
  vm.runInContext(source, context);
  const run = code => vm.runInContext(code, context);
  run("render=()=>{};nav=()=>{};openDialog=html=>{globalThis.dialogHTML=html;};toast=message=>{globalThis.toastMessage=message;};");
  return { run, requests, element, fakeWallet, connect(address) { fakeWallet.address = address;run(`state.connected=true;state.address=${JSON.stringify(address)};sessionAddress=state.address;sessionToken='test-session';`); }, state: () => JSON.parse(run('JSON.stringify(state)')), async click(action, id) { const target = { dataset: { action, id }, isConnected: false, disabled: false, setAttribute() {}, removeAttribute() {}, closest(selector) { return selector === '[data-action]' ? this : null; } };for (const handler of handlers.get('click') || []) await handler({ target, stopPropagation() {} }); } };
}

test('UI starts empty and ignores the previous browser-local fictional holdings', () => {
  const state = uiHarness().state();
  assert.equal(state.balance, null);assert.deepEqual(state.positions, []);assert.deepEqual(state.listings, []);assert.deepEqual(state.saved, []);assert.equal(state.connected, false);
});

test('UI never asks the wallet to sign an API challenge for another origin', async () => {
  const address = Keypair.generate().publicKey.toBase58();
  const ui = uiHarness(async () => authenticationChallenge({ address, origin: 'https://attacker.example' }));
  ui.connect(address);ui.run('sessionToken=null;sessionAddress=null;');
  let prompts = 0;ui.fakeWallet.signMessage = async () => { prompts++; return ''; };
  await assert.rejects(ui.run('ensureSession()'), /does not match this Sona connection/);
  assert.equal(prompts, 0);
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].path, '/api/auth/challenge');
});

test('UI signs and submits a valid origin-bound Sona authentication challenge', async () => {
  const address = Keypair.generate().publicKey.toBase58();
  const challenge = authenticationChallenge({ address });
  const ui = uiHarness(async path => path.endsWith('/challenge') ? challenge : { token: 'verified-session', address });
  ui.connect(address);ui.run('sessionToken=null;sessionAddress=null;');
  const messages = [];ui.fakeWallet.signMessage = async message => { messages.push(message); return 'signed-message'; };
  await ui.run('ensureSession()');
  assert.deepEqual(messages, [challenge.message]);
  assert.equal(ui.run('sessionToken'), 'verified-session');
  assert.equal(ui.requests[1].path, '/api/auth/verify');
  assert.deepEqual(JSON.parse(ui.requests[1].options.body), { address, challengeId: challenge.challengeId, signatureBase64: 'signed-message' });
});

test('UI does not open a signature prompt after the account changes during challenge loading', async () => {
  const address = Keypair.generate().publicKey.toBase58();
  let deliver;
  const ui = uiHarness(async () => new Promise(resolve => { deliver = resolve; }));
  ui.connect(address);ui.run('sessionToken=null;sessionAddress=null;');
  let prompts = 0;ui.fakeWallet.signMessage = async () => { prompts++; return ''; };
  const pending = ui.run('ensureSession()');
  ui.fakeWallet.address = Keypair.generate().publicKey.toBase58();
  deliver(authenticationChallenge({ address }));
  await assert.rejects(pending, /wallet changed/);
  assert.equal(prompts, 0);
});

test('market table treats unexpected API identifiers and verification slots as text', () => {
  const ui = uiHarness();
  const position = { id: 'listing" onclick="alert(1)', base: 'SOL', quote: 'USDC', protocol: 'Raydium', type: 'Fee rights', priceLamports: '1', lockDays: null, verifiedSlot: '<img src=x onerror=alert(1)>' };
  const html = ui.run(`table([${JSON.stringify(position)}])`);
  assert.doesNotMatch(html, /<img src=x|data-id="listing" onclick=/);
  assert.match(html, /listing&quot; onclick=&quot;alert\(1\)/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('UI SOL conversion is exact down to a lamport and rejects exponential/negative prices', () => {
  const ui = uiHarness();
  assert.equal(ui.run("solToLamports('0.000000001')"), '1');
  assert.equal(ui.run("solToLamports('999999.123456789')"), '999999123456789');
  assert.equal(ui.run("lamportsToSol('1')"), '0.000000001');
  assert.equal(ui.run("solDecimal('999999123456789')"), '999999.123456789');
  for (const invalid of ['0', '-1', '1e-9', '1.0000000001', '1000001']) assert.throws(() => ui.run(`solToLamports(${JSON.stringify(invalid)})`));
});

test('rendered market and wallet chooser preserve honest empty and missing-extension states', () => {
  const ui = uiHarness();ui.run('state.loading=false;renderMarket();');
  assert.match(ui.element('#results').innerHTML, /No positions listed yet/);
  assert.doesNotMatch(ui.element('#results').innerHTML, /125|BONK/);
  ui.run('walletModal();');assert.match(ui.run('dialogHTML'), /Not detected/);
  assert.doesNotMatch(ui.run('dialogHTML'), /Explore workspace|Use demo|data-action="connect"/);
});

test('failed purchase request does not change balance, holdings or ownership', async () => {
  const buyer = Keypair.generate().publicKey.toBase58(), seller = Keypair.generate().publicKey.toBase58();
  const ui = uiHarness(async () => ({ status: 502, body: { error: { message: 'RPC unavailable' } } }));ui.connect(buyer);
  ui.run(`state.balance=2;state.listings=[{id:'listing-1',seller:${JSON.stringify(seller)},status:'active',priceLamports:'1000000000'}];`);ui.element('#purchase-consent').checked = true;
  await ui.click('confirm-buy', 'listing-1');assert.equal(ui.state().balance, 2);assert.equal(ui.state().listings[0].status, 'active');assert.deepEqual(ui.state().positions, []);assert.match(ui.run('toastMessage'), /RPC unavailable/);
});

test('seller can resume prepared approval without trying to prepare it again', async () => {
  const seller = Keypair.generate(), buyer = Keypair.generate(), mint = Keypair.generate().publicKey.toBase58();
  const trade = { id: 'trade-1', seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), mint, priceLamports: '123456789', status: 'prepared' };
  const settlement = buildSettlementTransaction({ ...trade, sourceTokenAccount: Keypair.generate().publicKey.toBase58(), blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 });
  const ui = uiHarness(async path => path.endsWith('/approve') ? { trade: { ...trade, status: 'approved' } } : { trade, settlement });ui.connect(trade.seller);
  ui.run(`reviewedTrades.set('trade-1',${JSON.stringify(trade)});refreshData=async()=>{};showTrade=async()=>{};`);
  await ui.run("approveTrade('trade-1')");
  assert.equal(ui.requests.some(request => request.path.endsWith('/prepare')), false);assert.equal(ui.requests.some(request => request.path.endsWith('/approve')), true);
});

test('canonical client verification rejects hidden instructions and changed prices', () => {
  const seller = Keypair.generate(), buyer = Keypair.generate();
  const built = buildSettlementTransaction({ seller: seller.publicKey.toBase58(), buyer: buyer.publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(), sourceTokenAccount: Keypair.generate().publicKey.toBase58(), priceLamports: '10000000', blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 });
  assert.equal(assertSettlementTransaction(built.transactionBase64, built), true);
  assert.throws(() => assertSettlementTransaction(built.transactionBase64, { ...built, priceLamports: '10000001' }), /does not match/);
  built.transaction.add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: seller.publicKey, lamports: 1000 }));
  assert.throws(() => assertSettlementTransaction(bytesToBase64(built.transaction.serialize({ requireAllSignatures: false })), built), /does not match/);
});

test('partial discovery preserves verified positions and discloses the scan boundary', async () => {
  const address=Keypair.generate().publicKey.toBase58(),mint=Keypair.generate().publicKey.toBase58();
  const account={balanceLamports:'1000000000',positions:[{mint,base:'SOL',quote:'USDC',verifiedSlot:5}],listings:[],trades:[],activity:[],truncated:true,scannedCandidates:200,totalCandidates:321,rejected:[]};
  const ui=uiHarness(async path=>path==='/api/config'?{cluster:'mainnet-beta'}:path==='/api/listings'?{listings:[]}:account);ui.connect(address);
  await ui.run('refreshData()');assert.equal(ui.state().positions.length,1);assert.equal(ui.state().inventoryScan.truncated,true);
  ui.run('renderPortfolio()');assert.match(ui.element('#main').innerHTML,/Checked 200 of 321 candidate holdings/);assert.match(ui.element('#main').innerHTML,/remaining holdings have not been checked/);assert.match(ui.element('#main').innerHTML,/Positions found/);assert.match(ui.element('#main').innerHTML,/SOL/);
  ui.run('state.positions=[];renderPortfolio()');assert.match(ui.element('#main').innerHTML,/No Fee Keys in this scan/);assert.doesNotMatch(ui.element('#main').innerHTML,/No Fee Keys found/);
});
