import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LOCK_DISCRIMINATOR, POOL_DISCRIMINATOR, RAYDIUM_PROGRAMS, deriveLockAddress } from '../src/chain/raydium.mjs';
import { GENESIS_HASHES } from '../src/server/network.mjs';
import { SETUP_POOL, quoteSetup } from '../src/setup/quote.mjs';

// Synthetic account-layout fixtures only. These tests create no wallets on chain,
// never sign/broadcast, and must not be presented as mainnet transactions or quotes.
const SLOT = 500_000_000;
const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ids = Object.fromEntries(Object.entries(RAYDIUM_PROGRAMS['mainnet-beta']).map(([name, value]) => [name, new PublicKey(value)]));
const RENT = { 82: 1_066_800, 165: 1_488_440, 256: 1_950_720 };
function fixture({ poolAddress = SETUP_POOL, includeAtas = false } = {}) {
  const seller = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey, feeMint = Keypair.generate().publicKey;
  const pool = new PublicKey(poolAddress);
  const lp = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), pool.toBuffer()], ids.cpmm)[0];
  const vault = mint => PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), pool.toBuffer(), mint.toBuffer()], ids.cpmm)[0];
  const solVault = vault(SOL), usdcVault = vault(USDC), escrow = getAssociatedTokenAddressSync(lp, ids.lockAuthority, true);
  const source = getAssociatedTokenAddressSync(feeMint, seller), destination = getAssociatedTokenAddressSync(feeMint, buyer);
  const lock = deriveLockAddress(feeMint), accounts = new Map(), calls = [];
  const put = (key, data, owner = TOKEN_PROGRAM_ID, lamports = RENT[data.length] || 4_000_000) => {
    const info = { data, owner, lamports, executable: false }; accounts.set(key.toBase58(), info); return info;
  };
  const mint = (key, supply, decimals, authority) => {
    const data = Buffer.alloc(82);data.writeBigUInt64LE(supply, 36);data[44] = decimals;data[45] = 1;
    if (authority) { data.writeUInt32LE(1, 0);authority.toBuffer().copy(data, 4); }
    return put(key, data);
  };
  const token = (key, tokenMint, owner, amount) => {
    const data = Buffer.alloc(165);tokenMint.toBuffer().copy(data);owner.toBuffer().copy(data, 32);data.writeBigUInt64LE(amount, 64);data[108] = 1;
    return put(key, data);
  };
  const poolData = Buffer.alloc(637);POOL_DISCRIMINATOR.copy(poolData);solVault.toBuffer().copy(poolData, 72);usdcVault.toBuffer().copy(poolData, 104);
  lp.toBuffer().copy(poolData, 136);SOL.toBuffer().copy(poolData, 168);USDC.toBuffer().copy(poolData, 200);
  TOKEN_PROGRAM_ID.toBuffer().copy(poolData, 232);TOKEN_PROGRAM_ID.toBuffer().copy(poolData, 264);
  poolData[330] = 9;poolData[331] = 9;poolData[332] = 6;poolData.writeBigUInt64LE(1_000_000n, 333);
  put(pool, poolData, ids.cpmm);mint(lp, 1_000_000n, 9, ids.cpmmAuthority);mint(SOL, 0n, 9);mint(USDC, 10_000_000n, 6, Keypair.generate().publicKey);
  token(solVault, SOL, ids.cpmmAuthority, 1_000_000_000n);token(usdcVault, USDC, ids.cpmmAuthority, 20_000_000n);
  token(escrow, lp, ids.lockAuthority, 100n);
  put(seller, Buffer.alloc(0), SystemProgram.programId, 50_000_000);put(buyer, Buffer.alloc(0), SystemProgram.programId, 10_000_000);
  const atas = { sol: getAssociatedTokenAddressSync(SOL, seller), usdc: getAssociatedTokenAddressSync(USDC, seller), lp: getAssociatedTokenAddressSync(lp, seller) };
  if (includeAtas) { token(atas.sol, SOL, seller, 500n);token(atas.usdc, USDC, seller, 1_250_000n);token(atas.lp, lp, seller, 100n); }
  mint(feeMint, 1n, 0);token(source, feeMint, seller, 1n);
  const lockData = Buffer.alloc(256);LOCK_DISCRIMINATOR.copy(lockData);lockData.writeBigUInt64LE(100n, 8);
  pool.toBuffer().copy(lockData, 64);feeMint.toBuffer().copy(lockData, 96);seller.toBuffer().copy(lockData, 128);lp.toBuffer().copy(lockData, 160);put(lock, lockData, ids.lock);
  const connection = {
    async getGenesisHash() { calls.push('genesis');return GENESIS_HASHES['mainnet-beta']; },
    async getMultipleAccountsInfoAndContext(keys, config) {
      assert.equal(config.commitment, 'finalized');calls.push({ keys: keys.map(String), config });
      return { context: { slot: SLOT }, value: keys.map(key => accounts.get(String(key)) ?? null) };
    },
    async getTokenAccountsByOwner(owner, filter, config) {
      assert.ok(owner.equals(seller));assert.ok(filter.mint.equals(feeMint));assert.equal(config.commitment, 'finalized');calls.push('holder');
      return { context: { slot: SLOT }, value: [{ pubkey: source, account: accounts.get(String(source)) }] };
    },
    async getMinimumBalanceForRentExemption(size, commitment) { assert.equal(commitment, 'finalized');calls.push(`rent:${size}`);return RENT[size]; },
    async getLatestBlockhashAndContext(config) {
      assert.equal(config.commitment, 'finalized');calls.push('blockhash');
      return { context: { slot: SLOT }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: SLOT } };
    },
    async getFeeForMessage(message, commitment) {
      assert.equal(commitment, 'finalized');assert.equal(message.header.numRequiredSignatures, 2);assert.equal(message.instructions.length, 3);
      calls.push('fee');return { context: { slot: SLOT }, value: 10_000 };
    },
    sendRawTransaction() { assert.fail('A setup quote must never broadcast.'); },
    sendTransaction() { assert.fail('A setup quote must never send.'); },
    requestAirdrop() { assert.fail('A setup quote must never request funds.'); },
  };
  const input = { seller: String(seller), buyer: String(buyer) };
  return { seller, buyer, feeMint, pool, lp, solVault, usdcVault, escrow, source, destination, lock, atas, accounts, calls, connection, input, token,
    quote: (overrides = {}) => quoteSetup({ connection, input: { ...input, ...overrides } }),
    quoteKey: (overrides = {}) => quoteSetup({ connection, input: { ...input, feeKeyMint: String(feeMint), priceLamports: '1', ...overrides } }) };
}

test('creation plan authenticates pinned pool, reads current rents and never invents an all-in total', async () => {
  const f = fixture();const report = await f.quote();
  assert.equal(report.mode, 'create-fee-key');assert.equal(report.pool.address, SETUP_POOL);assert.equal(report.pool.verified, true);
  assert.equal(report.wallets.seller.nativeBalanceLamports, '50000000');assert.equal(report.wallets.buyer.nativeBalanceLamports, '10000000');
  assert.equal(report.creation.rentExemptionLamports.tokenAccount, '1488440');
  assert.equal(report.creation.lockAccountRent.knownSubtotalLamports, String(RENT[82] + RENT[165] + RENT[256]));
  assert.equal(report.creation.lockAccountRent.lpEscrow, '0');
  assert.equal(report.creation.missingSellerTokenAccountRentLamports, String(RENT[165] * 3));
  for (const key of ['depositPrincipal', 'transactionFeesLamports', 'metadataCostLamports', 'allInCostLamports']) assert.equal(report.creation[key], null);
  assert.equal(report.creation.principalIsPermanentlyLocked, true);assert.equal(report.settlement, null);
  assert.equal(report.networkWrites, 0);assert.equal(report.transactionsSent, 0);
  assert.equal(f.calls.includes('blockhash'), false);assert.equal(f.calls.includes('fee'), false);
  assert.equal(Object.keys(report.pool.evidence.accounts).length, 7);
  assert.match(report.pool.evidence.accounts[SETUP_POOL].sha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => JSON.stringify(report));
});

test('existing account balances remain exact strings and missing escrow rent is conditional', async () => {
  const f = fixture({ includeAtas: true });f.accounts.delete(String(f.escrow));
  f.accounts.get(String(f.atas.usdc)).data.writeBigUInt64LE(9_007_199_254_740_993n, 64);
  const report = await f.quote();
  assert.equal(report.creation.sellerTokenAccounts.usdc.amount, '9007199254740993');
  assert.equal(report.creation.missingSellerTokenAccountRentLamports, '0');
  assert.equal(report.creation.lockAccountRent.lpEscrow, String(RENT[165]));
  assert.equal(report.creation.lockAccountRent.knownSubtotalLamports, String(RENT[82] + RENT[165] * 2 + RENT[256]));
  assert.equal(report.pool.evidence.accounts[String(f.escrow)], null);
});

test('creation uses small pool and wallet batches and preserves their separate finalized slots', async () => {
  const f = fixture(), read = f.connection.getMultipleAccountsInfoAndContext;
  f.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
    assert.ok(keys.length <= 7, 'Creation reads must fit a seven-account free-provider batch.');
    const result = await read(keys, config);
    if (keys.length === 7) result.context.slot = SLOT + 1;
    if (keys.length === 5) { assert.equal(config.minContextSlot, SLOT + 1);result.context.slot = SLOT + 3; }
    return result;
  };
  const report = await f.quote();
  assert.deepEqual(f.calls.filter(call => call.keys).map(call => call.keys.length), [1, 7, 5]);
  assert.equal(report.pool.slot, SLOT + 1);assert.equal(report.pool.evidence.snapshotSlot, SLOT + 1);
  assert.equal(report.wallets.snapshotSlot, SLOT + 3);assert.equal(report.creation.snapshotSlot, SLOT + 3);
  assert.equal(report.creation.poolSnapshotSlot, SLOT + 1);assert.equal(report.creation.walletSnapshotSlot, SLOT + 3);
  assert.match(report.statement, /separate finalized snapshots/);
  assert.match(report.statement, /not one atomic observation/);
});

test('a stale or incomplete separate wallet snapshot cannot return a creation quote', async () => {
  for (const broken of ['stale', 'incomplete']) {
    const f = fixture(), read = f.connection.getMultipleAccountsInfoAndContext;
    f.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
      const result = await read(keys, config);
      if (keys.length === 5) {
        if (broken === 'stale') result.context.slot--;
        else result.value.pop();
      }
      return result;
    };
    await assert.rejects(f.quote(), { code: broken === 'stale' ? 'STALE_RPC_STATE' : 'MISSING_RPC_DATA' });
  }
});

test('absent ordinary wallet accounts are zero balances, never funded automatically', async () => {
  const f = fixture();f.accounts.delete(String(f.seller));f.accounts.delete(String(f.buyer));
  const report = await f.quote();assert.equal(report.wallets.seller.nativeBalanceLamports, '0');assert.equal(report.wallets.buyer.nativeBalanceLamports, '0');
});

test('private-key fields, arbitrary RPC/pool inputs, self-trades and noncanonical prices fail before RPC', async () => {
  const f = fixture();
  for (const overrides of [
    { privateKey: 'not-accepted' }, { rpcUrl: 'https://untrusted.invalid' }, { poolId: SETUP_POOL }, { buyer: f.input.seller },
    { seller: String(f.escrow) }, { seller: ' ' + f.input.seller }, { feeKeyMint: null },
    { feeKeyMint: String(f.feeMint) }, { priceLamports: 1 }, { priceLamports: '0' }, { priceLamports: '01' },
    { priceLamports: '18446744073709551616' }, { priceLamports: '1'.repeat(1000) },
  ]) await assert.rejects(f.quote(overrides));
  assert.deepEqual(f.calls, []);
});

test('setup enforces the marketplace price cap before RPC and accepts the exact boundary', async () => {
  const rejected = fixture();
  await assert.rejects(rejected.quoteKey({ priceLamports: '1000000000000001' }), { code: 'INVALID_SETUP_INPUT', status: 400 });
  assert.deepEqual(rejected.calls, []);
  const allowed = fixture();
  const report = await allowed.quoteKey({ priceLamports: '1000000000000000' });
  assert.equal(report.settlement.terms.priceLamports, '1000000000000000');
  assert.equal(report.settlement.readyToSettle, false, 'A valid price does not imply the buyer is funded.');
  assert.equal(report.settlement.costs.additionalLamportsNeeded,
    (1_000_000_000_000_000n + 10_000n + BigInt(RENT[165]) - 10_000_000n).toString());
});

test('wrong network and unsafe or stale RPC numbers never become valid quotes', async () => {
  const wrong = fixture();wrong.connection.getGenesisHash = async () => GENESIS_HASHES.devnet;
  await assert.rejects(wrong.quote(), /genesis/);
  for (const mutate of [
    f => { f.accounts.get(String(f.buyer)).lamports = Number.MAX_SAFE_INTEGER + 1; },
    f => { f.connection.getMinimumBalanceForRentExemption = async () => null; },
    f => { f.connection.getMinimumBalanceForRentExemption = async () => 0.5; },
    f => { const read = f.connection.getMultipleAccountsInfoAndContext;f.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
      const result = await read(keys, config);if (keys.length > 1) result.context.slot--;return result;
    }; },
  ]) { const f = fixture();mutate(f);await assert.rejects(f.quote()); }
});

for (const [name, mutate] of [
  ['pool program', f => { f.accounts.get(String(f.pool)).owner = SystemProgram.programId; }],
  ['pool discriminator', f => { f.accounts.get(String(f.pool)).data[0] ^= 1; }],
  ['pool mint', f => { f.seller.toBuffer().copy(f.accounts.get(String(f.pool)).data, 168); }],
  ['pool token program', f => { TOKEN_2022_PROGRAM_ID.toBuffer().copy(f.accounts.get(String(f.pool)).data, 232); }],
  ['LP mint authority', f => { f.seller.toBuffer().copy(f.accounts.get(String(f.lp)).data, 4); }],
  ['vault authority', f => { f.seller.toBuffer().copy(f.accounts.get(String(f.solVault)).data, 32); }],
  ['vault canonical address', f => { f.seller.toBuffer().copy(f.accounts.get(String(f.pool)).data, 72); }],
  ['escrow authority', f => { f.seller.toBuffer().copy(f.accounts.get(String(f.escrow)).data, 32); }],
  ['wallet program', f => { f.accounts.get(String(f.buyer)).owner = TOKEN_PROGRAM_ID; }],
]) test(`rejects a substituted ${name}`, async () => { const f = fixture();mutate(f);await assert.rejects(f.quote()); });

test('pool identity is checked again in the final consistent snapshot', async () => {
  const f = fixture(), read = f.connection.getMultipleAccountsInfoAndContext;
  f.connection.getMultipleAccountsInfoAndContext = async (keys, config) => {
    if (keys.length > 1) f.seller.toBuffer().copy(f.accounts.get(String(f.pool)).data, 200);
    return read(keys, config);
  };
  await assert.rejects(f.quote(), { code: 'INVALID_SETUP_POOL' });
});

test('seller account permissions are visible and frozen/wrong-mint accounts cannot masquerade as spendable balances', async () => {
  const f = fixture({ includeAtas: true }), info = f.accounts.get(String(f.atas.usdc));
  info.data.writeUInt32LE(1, 72);f.buyer.toBuffer().copy(info.data, 76);
  info.data.writeUInt32LE(1, 129);f.buyer.toBuffer().copy(info.data, 133);
  const report = await f.quote();assert.equal(report.creation.sellerTokenAccounts.usdc.delegated, true);
  assert.equal(report.creation.sellerTokenAccounts.usdc.thirdPartyCloseAuthority, true);
  info.data[108] = 2;await assert.rejects(f.quote(), { code: 'INVALID_SETUP_ACCOUNT' });
  info.data[108] = 1;SOL.toBuffer().copy(info.data);await assert.rejects(f.quote(), { code: 'INVALID_SETUP_ACCOUNT' });
});

test('an existing eligible Fee Key from another CPMM pool skips creation and uses real canonical preflight', async () => {
  const f = fixture({ poolAddress: Keypair.generate().publicKey.toBase58() });
  const report = await f.quoteKey();
  assert.equal(report.mode, 'existing-fee-key');assert.equal(report.pool.address, String(f.pool));assert.notEqual(report.pool.address, SETUP_POOL);
  assert.equal(report.creation, null);assert.equal(report.settlement.verified, true);assert.equal(report.settlement.readyToSettle, true);
  assert.equal(report.settlement.terms.priceLamports, '1');assert.equal(report.settlement.costs.networkFeeLamports, '10000');
  assert.equal(report.settlement.costs.buyerAtaRentLamports, String(RENT[165]));
  assert.equal(report.settlement.costs.totalEstimatedBuyerDebitLamports, String(RENT[165] + 10_001));
  assert.equal(report.settlement.feeKey.tokenAccount, String(f.source));
  assert.equal(f.calls.some(call => call.keys?.includes(SETUP_POOL)), false);
  assert.equal(JSON.stringify(report).includes('transactionBase64'), false);
});

test('existing-key quote reports exact shortfall and recognizes safe existing buyer ATA', async () => {
  const f = fixture();f.accounts.get(String(f.buyer)).lamports = 100;
  f.token(f.destination, f.feeMint, f.buyer, 0n);
  const report = await f.quoteKey({ priceLamports: '200' });
  assert.equal(report.settlement.readyToSettle, false);assert.equal(report.settlement.costs.buyerAtaRentLamports, '0');
  assert.equal(report.settlement.costs.additionalLamportsNeeded, '10100');
});

test('non-Ray­dium tokens, delegated sources and delegated destinations cannot obtain settlement quotes', async () => {
  for (const mutate of [
    f => { f.accounts.delete(String(f.lock)); },
    f => { const info = f.accounts.get(String(f.source));info.data.writeUInt32LE(1, 72);f.buyer.toBuffer().copy(info.data, 76); },
    f => { const info = f.token(f.destination, f.feeMint, f.buyer, 0n);info.data.writeUInt32LE(1, 72);f.seller.toBuffer().copy(info.data, 76); },
  ]) { const f = fixture();mutate(f);await assert.rejects(f.quoteKey()); }
});

test('holder discovery is bounded, exact and does not accept duplicate or stale responses', async () => {
  for (const mutate of [
    f => { f.connection.getTokenAccountsByOwner = async () => ({ context: { slot: SLOT }, value: [] }); },
    f => { f.connection.getTokenAccountsByOwner = async () => ({ context: { slot: SLOT }, value: Array(33).fill({}) }); },
    f => { const read = f.connection.getTokenAccountsByOwner;f.connection.getTokenAccountsByOwner = async (...args) => {
      const result = await read(...args);result.value.push(result.value[0]);return result;
    }; },
    f => { const read = f.connection.getTokenAccountsByOwner;f.connection.getTokenAccountsByOwner = async (...args) => {
      const result = await read(...args);result.context.slot++;return result;
    }; },
  ]) { const f = fixture();mutate(f);await assert.rejects(f.quoteKey()); }
});

test('RPC failures propagate instead of becoming absent accounts or zero costs', async () => {
  const f = fixture();f.connection.getMultipleAccountsInfoAndContext = async () => { throw new Error('RPC unavailable'); };
  await assert.rejects(f.quote(), /RPC unavailable/);
});
