import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { inspectSettlementAsset, prepareSettlement } from '../src/chain/settlement.mjs';

function fixture() {
  const seller = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey, thirdParty = Keypair.generate().publicKey;
  const sourceTokenAccount = getAssociatedTokenAddressSync(mint, seller);
  const destination = getAssociatedTokenAddressSync(mint, buyer);
  const account = (data) => ({ owner: TOKEN_PROGRAM_ID, executable: false, lamports: 2_000_000, data });
  const mintData = Buffer.alloc(82); mintData.writeBigUInt64LE(1n, 36); mintData[45] = 1;
  const tokenData = owner => {
    const data = Buffer.alloc(165); mint.toBuffer().copy(data, 0); owner.toBuffer().copy(data, 32); data[108] = 1; return data;
  };
  const source = account(tokenData(seller)); source.data.writeBigUInt64LE(1n, 64);
  const target = account(tokenData(buyer));
  const accounts = new Map([[String(mint), account(mintData)], [String(sourceTokenAccount), source], [String(destination), target]]);
  let lifetimes = 0;
  const connection = {
    getAccountInfo: async address => accounts.get(String(address)) || null,
    getLatestBlockhash: async () => { lifetimes++; return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }; },
  };
  return { seller, buyer, mint, sourceTokenAccount, destination, thirdParty, source, target, accounts, connection, get lifetimes() { return lifetimes; } };
}

const inspect = f => inspectSettlementAsset(f);

test('destination checks permit a new ATA and an existing empty ATA without third-party permissions', async () => {
  const f = fixture();
  await inspect(f);
  f.target.data.writeUInt32LE(1, 129); f.buyer.toBuffer().copy(f.target.data, 133);
  await inspect(f);
  f.accounts.delete(String(f.destination));
  await inspect(f);
});

test('a delegate retained by an empty buyer ATA blocks preparation before approval construction', async () => {
  const f = fixture();
  f.target.data.writeUInt32LE(1, 72); f.thirdParty.toBuffer().copy(f.target.data, 76);
  f.target.data.writeBigUInt64LE(1n, 121);
  await assert.rejects(prepareSettlement({ connection: f.connection, buyer: f.buyer,
    listing: { seller: f.seller, mint: f.mint, sourceTokenAccount: f.sourceTokenAccount, priceLamports: '1' },
    verifyFeeKey: async () => ({ verified: true, mint: f.mint }) }), { code: 'UNSAFE_DESTINATION' });
  assert.equal(f.lifetimes, 0, 'No transaction or approval is created for an unsafe destination.');
});

test('source delegation is rejected by the standalone ownership inspection as well as the Raydium verifier', async () => {
  const f = fixture();
  f.source.data.writeUInt32LE(1, 72); f.thirdParty.toBuffer().copy(f.source.data, 76);
  await assert.rejects(inspect(f), { code: 'DELEGATED_NFT' });
});

for (const [name, mutate, code] of [
  ['foreign close authority', f => { f.target.data.writeUInt32LE(1, 129); f.thirdParty.toBuffer().copy(f.target.data, 133); }, 'UNSAFE_DESTINATION'],
  ['wrong owner', f => f.thirdParty.toBuffer().copy(f.target.data, 32), 'INVALID_DESTINATION'],
  ['wrong mint', f => f.thirdParty.toBuffer().copy(f.target.data, 0), 'INVALID_DESTINATION'],
  ['frozen destination', f => { f.target.data[108] = 2; }, 'INVALID_DESTINATION'],
  ['uninitialized destination', f => { f.target.data[108] = 0; }, 'INVALID_DESTINATION'],
  ['nonempty destination', f => f.target.data.writeBigUInt64LE(1n, 64), 'INVALID_DESTINATION'],
  ['Token-2022 destination', f => { f.target.owner = TOKEN_2022_PROGRAM_ID; }, 'INVALID_DESTINATION'],
  ['executable destination', f => { f.target.executable = true; }, 'INVALID_DESTINATION'],
  ['unsupported account layout', f => { f.target.data = Buffer.concat([f.target.data, Buffer.alloc(1)]); }, 'INVALID_DESTINATION'],
]) test(`rejects ${name}`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(inspect(f), { code });
});

test('destination RPC failures propagate rather than being treated as an absent ATA', async () => {
  const f = fixture(), read = f.connection.getAccountInfo;
  f.connection.getAccountInfo = address => {
    if (new PublicKey(address).equals(f.destination)) throw new Error('RPC unavailable');
    return read(address);
  };
  await assert.rejects(inspect(f), /RPC unavailable/);
});
