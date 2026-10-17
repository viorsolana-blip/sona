import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { verifyFeeKey, discoverFeeKeys, deriveLockAddress, decodeLockedLiquidity, decodeCpmmPool, RAYDIUM_PROGRAMS } from '../src/chain/raydium.mjs';

// Actual finalized mainnet snapshot, public RPC slot 458138200. Not a Sona transaction.
// RPC endpoint, source transaction and provenance are documented in evidence/RAYDIUM-SOURCES.md.
const PUBLIC_FIXTURE = {
  "slot": 458138200,
  "accounts": {
    "GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o": {
      "data": [
        "AAAAACd6iHv0dCkMYRKaa6rcaZeYwmKCkckm0kM2JNmnmmAaAQAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        "base64"
      ],
      "executable": false,
      "lamports": 1066800,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "rentEpoch": 18446744073709551615,
      "space": 82
    },
    "6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7": {
      "data": [
        "5i5WlUIxa7ZM1GdErklUZ2gIaXiIEjVL4tnSaJPOaiiKgHUiQYRWbpMZ21rzy+wt/EJHauY5YD77RfO5T5Gn8QEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "base64"
      ],
      "executable": false,
      "lamports": 1488440,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "rentEpoch": 18446744073709551615,
      "space": 165
    },
    "GAHVFUQAVEKgwvcZbU3verA5QPPk4jBvGdaZuhqgJLXU": {
      "data": [
        "GQruxc/qSRYwkcv+yAAAAEfnqPsPAAAAAAAAAAAAAACUkcv+yAAAAFN8WhQJW6fdKLgAAAAAAAAkBAAAAAAAADA1EijZn2xSbkz98hrkEbvtPsT5/rbt8ImtmwuGthcb5i5WlUIxa7ZM1GdErklUZ2gIaXiIEjVL4tnSaJPOaigrxoE8cZjqDQh/sHmRH8FPcmohJuiWiBmvHrz+BdUjjkeCyuVxQL7uQiipU5ozrm2hYgRlw5l7zUvWlbdSTho6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        "base64"
      ],
      "executable": false,
      "lamports": 1950720,
      "owner": "LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE",
      "rentEpoch": 18446744073709551615,
      "space": 256
    },
    "4FBWLAbYs6TXSnbsGCyUNsu2gq3CWCHVo5ujYBKvfmG6": {
      "data": [
        "9+3j9dfD3kbg8ZBqw116/569tMdvdVT73E1P2/m/qNpAvRtJHF3k5SvGgTxxmOoNCH+weZEfwU9yaiEm6JaIGa8evP4F1SOOTtoRFTKom4BHIEqEb+Ml36HVee/liDzrp74zdl1e3vGpD6FaWs8XOhTnVnQKLKZ0eymK6K5X6wdc+jLuZa0s9UeCyuVxQL7uQiipU5ozrm2hYgRlw5l7zUvWlbdSTho6BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEPLf/OHF7hIcd5MYIKsAGETMGrCQK3RTK25oR/QJZkwgbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpBt324e51j94YQl285GzN2rYa/E2DuQ0n/r35KNihi/wkktRcSKfL108f9uLodGS1cP32jpTwO9vTFvdiUJjGof0ACQkGlJHL/sgAAABqbhgBAAAAAET3Z5RrAAAAGXpdAAAAAADLIibXIwAAACZs0GoAAAAAJAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        "base64"
      ],
      "executable": false,
      "lamports": 3886200,
      "owner": "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
      "rentEpoch": 18446744073709551615,
      "space": 637
    },
    "5p9cyBAx9wZcZ9CeKhttiRKwykuvLioY1ut4zbPCWvHo": {
      "data": [
        "AQAAAOsA2fWykrQhSsfQN7TW8GRQuWRgDfNzBSu16E8vjppnMJHL/sgAAAAJAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        "base64"
      ],
      "executable": false,
      "lamports": 1066800,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "rentEpoch": 18446744073709551615,
      "space": 82
    },
    "A3Hdukkh1BWeoVo5d5CVPLf13LiA2xUzaFgb46VcQZvY": {
      "data": [
        "R4LK5XFAvu5CKKlTmjOubaFiBGXDmXvNS9aVt1JOGjoneoh79HQpDGESmmuq3GmXmMJigpHJJtJDNiTZp5pgGjCRy/7IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "base64"
      ],
      "executable": false,
      "lamports": 1488440,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "rentEpoch": 18446744073709551615,
      "space": 165
    },
    "6JofGPUezDC2KAu2VRY7NQSrWTRkfVZnTWqupSztMxLx": {
      "data": [
        "BpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAHrANn1spK0IUrH0De01vBkULlkYA3zcwUrtehPL46aZwbr0NUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQEAAAA4thYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "base64"
      ],
      "executable": false,
      "lamports": 3588727102,
      "owner": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "rentEpoch": 18446744073709551615,
      "space": 165
    },
    "CNwj1xzUuAitiPSXqq3HMRE5ySDTMdn1D2JNtVjjZYUU": {
      "data": [
        "Dy3/zhxe4SHHeTGCCrABhEzBqwkCt0UytuaEf0CWZMLrANn1spK0IUrH0De01vBkULlkYA3zcwUrtehPL46aZwBQRsOR3gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "base64"
      ],
      "executable": false,
      "lamports": 1488440,
      "owner": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "rentEpoch": 18446744073709551615,
      "space": 165
    }
  }
};

const MINT = 'GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o';
const OWNER = 'AKesWP7KUE9QSnZuU35yQE8HcWQbTsRGMKAbaqESHVrx';
const HOLDER = '6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7';
const LOCK = 'GAHVFUQAVEKgwvcZbU3verA5QPPk4jBvGdaZuhqgJLXU';
const POOL = '4FBWLAbYs6TXSnbsGCyUNsu2gq3CWCHVo5ujYBKvfmG6';
const LP = '5p9cyBAx9wZcZ9CeKhttiRKwykuvLioY1ut4zbPCWvHo';
const ESCROW = 'A3Hdukkh1BWeoVo5d5CVPLf13LiA2xUzaFgb46VcQZvY';
const VAULT = '6JofGPUezDC2KAu2VRY7NQSrWTRkfVZnTWqupSztMxLx';
const OTHER = new PublicKey('11111111111111111111111111111111');

function setup() {
  const accounts = Object.fromEntries(Object.entries(PUBLIC_FIXTURE.accounts).map(([address, account]) => [address, {
    ...account, owner: new PublicKey(account.owner), data: Buffer.from(account.data[0], 'base64'),
  }]));
  const calls = [];
  const connection = {
    async getMultipleAccountsInfoAndContext(keys, config) {
      calls.push({ keys, config });
      return { context: { slot: PUBLIC_FIXTURE.slot }, value: keys.map(key => accounts[key.toBase58()] ?? null) };
    },
    async getTokenAccountsByOwner(owner, filter) {
      return { context: { slot: PUBLIC_FIXTURE.slot }, value: [
        { pubkey: new PublicKey(HOLDER), account: accounts[HOLDER] },
      ] };
    },
  };
  return { accounts, calls, connection };
}
const verify = connection => verifyFeeKey({ connection, mint: MINT, owner: OWNER, tokenAccount: HOLDER, commitment: 'finalized' });

test('an actual public Raydium Fee Key passes all eight-account checks without metadata', async () => {
  const { connection, calls } = setup();
  const proof = await verify(connection);
  assert.equal(proof.verified, true);
  assert.equal(proof.mint, MINT);
  assert.equal(proof.lockAccount, LOCK);
  assert.equal(proof.poolId, POOL);
  assert.equal(proof.lockedLpAmount, '863268213040');
  assert.equal(proof.slot, 458138200);
  assert.equal(proof.tokenProgram, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(proof.mintProgramB, TOKEN_2022_PROGRAM_ID.toBase58());
  assert.notEqual(proof.originalLockOwner, OWNER, 'Historical lock owner must not block secondary transfers.');
  assert.equal(Object.keys(proof.evidence.accounts).length, 8);
  assert.match(proof.evidence.accounts[LOCK].sha256, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => JSON.stringify(proof));
  assert.equal(calls.at(-1).keys.length, 8);
  assert.equal(calls.at(-1).config.minContextSlot, 458138200);
});

test('official mainnet PDA matches the real account and devnet derives independently', () => {
  assert.equal(deriveLockAddress(MINT).toBase58(), LOCK);
  assert.notEqual(deriveLockAddress(MINT, 'devnet').toBase58(), LOCK);
  for (const cluster of ['mainnet-beta', 'devnet']) {
    const ids = RAYDIUM_PROGRAMS[cluster];
    const [authority] = PublicKey.findProgramAddressSync([Buffer.from('lock_cp_authority_seed')], new PublicKey(ids.lock));
    assert.equal(authority.toBase58(), ids.lockAuthority);
  }
  assert.throws(() => deriveLockAddress(MINT, 'testnet'), { code: 'UNSUPPORTED_CLUSTER' });
});

const tampering = [
  ['fake lock program owner', a => { a[LOCK].owner = OTHER; }, 'NOT_RAYDIUM_FEE_KEY'],
  ['wrong lock discriminator', a => { a[LOCK].data[0] ^= 1; }, 'INVALID_LOCK_DISCRIMINATOR'],
  ['truncated lock', a => { a[LOCK].data = a[LOCK].data.subarray(0, 255); }, 'NOT_RAYDIUM_FEE_KEY'],
  ['wrong mint in canonical lock', a => { OTHER.toBuffer().copy(a[LOCK].data, 96); }, 'LOCK_MINT_MISMATCH'],
  ['zero locked amount', a => { a[LOCK].data.writeBigUInt64LE(0n, 8); }, 'EMPTY_LOCK'],
  ['wrong linked LP mint', a => { OTHER.toBuffer().copy(a[LOCK].data, 160); }, 'LP_MINT_MISMATCH'],
  ['fake pool owner', a => { a[POOL].owner = OTHER; }, 'INVALID_POOL'],
  ['wrong pool discriminator', a => { a[POOL].data[0] ^= 1; }, 'INVALID_POOL_DISCRIMINATOR'],
  ['Token-2022 Fee Key', a => { a[MINT].owner = TOKEN_2022_PROGRAM_ID; }, 'INVALID_MINT'],
  ['fungible NFT supply', a => { a[MINT].data.writeBigUInt64LE(2n, 36); }, 'NOT_UNIQUE_NFT'],
  ['divisible NFT', a => { a[MINT].data[44] = 1; }, 'NOT_UNIQUE_NFT'],
  ['mint authority remains', a => { a[MINT].data.writeUInt32LE(1, 0); }, 'MUTABLE_NFT'],
  ['freeze authority remains', a => { a[MINT].data.writeUInt32LE(1, 46); }, 'MUTABLE_NFT'],
  ['wrong holder', a => { OTHER.toBuffer().copy(a[HOLDER].data, 32); }, 'NOT_HELD'],
  ['wrong held mint', a => { OTHER.toBuffer().copy(a[HOLDER].data, 0); }, 'NOT_HELD'],
  ['holder no longer owns token', a => { a[HOLDER].data.writeBigUInt64LE(0n, 64); }, 'NOT_HELD'],
  ['frozen holder account', a => { a[HOLDER].data[108] = 2; }, 'NOT_HELD'],
  ['delegated holder account', a => { a[HOLDER].data.writeUInt32LE(1, 72); }, 'DELEGATED_NFT'],
  ['wrong LP authority', a => { OTHER.toBuffer().copy(a[LP].data, 4); }, 'INVALID_LP_MINT'],
  ['insufficient Raydium LP escrow', a => { a[ESCROW].data.writeBigUInt64LE(1n, 64); }, 'INVALID_LP_ESCROW'],
  ['wrong escrow authority', a => { OTHER.toBuffer().copy(a[ESCROW].data, 32); }, 'INVALID_LP_ESCROW'],
  ['wrong pool vault authority', a => { OTHER.toBuffer().copy(a[VAULT].data, 32); }, 'INVALID_POOL_VAULT'],
  ['missing lock', a => { delete a[LOCK]; }, 'NOT_RAYDIUM_FEE_KEY'],
];
for (const [description, mutate, code] of tampering) test(`rejects ${description}`, async () => {
  const { connection, accounts } = setup();
  mutate(accounts);
  await assert.rejects(verify(connection), { code });
});

test('discovers the actual Fee Key and can resolve its current token account', async () => {
  const { connection } = setup();
  const result = await discoverFeeKeys({ connection, owner: OWNER });
  assert.equal(result.positions.length, 1);
  assert.equal(result.positions[0].mint, MINT);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.rejected, []);
  assert.equal((await verifyFeeKey({ connection, mint: MINT, owner: OWNER })).tokenAccount, HOLDER);
});

test('absence of a Raydium lock is skipped, malformed lock is a visible rejection', async () => {
  const { connection, accounts } = setup();
  delete accounts[LOCK];
  assert.equal((await discoverFeeKeys({ connection, owner: OWNER })).positions.length, 0);
  accounts[LOCK] = { ...accounts[POOL] };
  const result = await discoverFeeKeys({ connection, owner: OWNER });
  assert.equal(result.positions.length, 0);
  assert.equal(result.rejected[0].code, 'NOT_RAYDIUM_FEE_KEY');
});

test('RPC failures are never disguised as an empty wallet', async () => {
  const { connection } = setup();
  const failure = new Error('Public RPC is rate limited');
  connection.getMultipleAccountsInfoAndContext = async () => { throw failure; };
  await assert.rejects(discoverFeeKeys({ connection, owner: OWNER }), failure);
  await assert.rejects(verify(connection), failure);
});

test('bounded discovery reports truncation instead of pretending the scan is complete', async () => {
  const { connection, accounts } = setup();
  connection.getTokenAccountsByOwner = async () => ({ context: { slot: PUBLIC_FIXTURE.slot }, value: [
    { pubkey: new PublicKey(HOLDER), account: accounts[HOLDER] },
    { pubkey: OTHER, account: { ...accounts[HOLDER], data: Buffer.from(accounts[HOLDER].data) } },
  ] });
  const result = await discoverFeeKeys({ connection, owner: OWNER, maxCandidates: 1 });
  assert.equal(result.positions.length, 1);
  assert.equal(result.scannedCandidates, 1);
  assert.equal(result.totalCandidates, 2);
  assert.equal(result.truncated, true);
});

test('wide discovery skips unrelated tokens before spending its deeper verification budget', async () => {
  const { connection, accounts, calls } = setup();
  const unrelated = Array.from({ length: 150 }, (_, index) => {
    const bytes = Buffer.alloc(32); bytes.writeUInt32LE(index + 1000, 0);
    const mint = new PublicKey(bytes), data = Buffer.from(accounts[HOLDER].data); mint.toBuffer().copy(data, 0);
    return { pubkey: mint, account: { ...accounts[HOLDER], data } };
  });
  connection.getTokenAccountsByOwner = async () => ({ context: { slot: PUBLIC_FIXTURE.slot }, value: [...unrelated, { pubkey: new PublicKey(HOLDER), account: accounts[HOLDER] }] });
  const result = await discoverFeeKeys({ connection, owner: OWNER, maxCandidates: 200, maxVerificationCalls: 8 });
  assert.equal(result.positions[0].mint, MINT); assert.equal(result.scannedCandidates, 151);
  assert.equal(result.verificationCalls, 1); assert.equal(result.deferredCandidates, 0); assert.equal(result.truncated, false);
  assert.equal(calls.length, 5, 'Two batched lock scans and three authenticated account reads.');
});

test('verification budget reports deferred candidates without additional deep RPC reads', async () => {
  const { connection, accounts, calls } = setup();
  connection.getTokenAccountsByOwner = async () => ({ context: { slot: PUBLIC_FIXTURE.slot }, value: Array.from({ length: 12 }, () => ({ pubkey: new PublicKey(HOLDER), account: accounts[HOLDER] })) });
  const result = await discoverFeeKeys({ connection, owner: OWNER, maxVerificationCalls: 2 });
  assert.equal(result.verificationCalls, 2); assert.equal(result.deferredCandidates, 10); assert.equal(result.truncated, true);
  assert.equal(calls.length, 7);
});

test('a second-read failure propagates and does not return a partial proof', async () => {
  const { connection } = setup();
  const original = connection.getMultipleAccountsInfoAndContext;
  let calls = 0;
  connection.getMultipleAccountsInfoAndContext = async (...args) => {
    if (++calls === 3) throw new Error('Snapshot unavailable');
    return original(...args);
  };
  await assert.rejects(verify(connection), /Snapshot unavailable/);
});

test('processed commitment and invalid limits fail before an RPC read', async () => {
  const { connection, calls } = setup();
  await assert.rejects(verifyFeeKey({ connection, mint: MINT, owner: OWNER, tokenAccount: HOLDER, commitment: 'processed' }), { code: 'UNSUPPORTED_COMMITMENT' });
  await assert.rejects(discoverFeeKeys({ connection, owner: OWNER, maxCandidates: 9999 }), { code: 'INVALID_LIMIT' });
  assert.equal(calls.length, 0);
});

test('decoder integers preserve full u64 and u128 precision', () => {
  const { accounts } = setup();
  accounts[LOCK].data.writeBigUInt64LE(2n ** 64n - 1n, 8);
  accounts[LOCK].data.writeBigUInt64LE(2n ** 64n - 1n, 40);
  accounts[LOCK].data.writeBigUInt64LE(2n ** 64n - 1n, 48);
  const decoded = decodeLockedLiquidity(accounts[LOCK].data);
  assert.equal(decoded.lockedLpAmount, 18446744073709551615n);
  assert.equal(decoded.lastK, 2n ** 128n - 1n);
  assert.equal(decodeCpmmPool(accounts[POOL].data).lpMint.toBase58(), LP);
});
