import test from 'node:test';
import assert from 'node:assert/strict';
import { lamportsFromSol, decimalUnits, savedPublicFields, requestGate, assertQuoteMatches } from '../../public/setup/state.mjs';

test('setup prices and display retain all integer precision, including amounts beyond Number safety', () => {
  assert.equal(lamportsFromSol('0.000001'), '1000');
  assert.equal(lamportsFromSol('0.000000001'), '1');
  assert.equal(lamportsFromSol('1000000'), '1000000000000000');
  assert.equal(decimalUnits('18446744073709551615'), '18446744073.709551615');
  assert.equal(decimalUnits('1000000', 6), '1');
  for (const price of ['0', '-1', '1e-6', '.1', '1.0000000001', '18446744073.709551616', '1000000.000000001', '', '01', 0.1]) assert.throws(() => lamportsFromSol(price));
});

test('downloadable preflight must match the full selected terms and verified finalized mainnet identity', () => {
  const input = { seller: 'seller', buyer: 'buyer', feeKeyMint: 'mint', priceLamports: '1000' };
  const chain = { cluster: 'mainnet-beta', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', commitment: 'finalized', networkWrites: 0, transactionsSent: 0 };
  const proof = { ...chain, schemaVersion: 1, kind: 'sona-setup-quote', readOnly: true, mode: 'existing-fee-key', creation: null,
    wallets: { seller: { address: 'seller' }, buyer: { address: 'buyer' } }, pool: { verified: true },
    settlement: { ...chain, kind: 'mainnet-sale-preflight', verified: true, terms: { seller: 'seller', buyer: 'buyer', mint: 'mint', priceLamports: '1000' } } };
  assert.doesNotThrow(() => assertQuoteMatches(proof, input));
  for (const mutate of [p => p.settlement.terms.seller = 'other', p => p.settlement.terms.buyer = 'other', p => p.mode = 'create-fee-key', p => p.settlement.verified = false,
    p => p.settlement.genesisHash = 'devnet', p => p.readOnly = false, p => p.settlement.commitment = 'confirmed', p => p.transactionsSent = 1]) {
    const changed = structuredClone(proof); mutate(changed); assert.throws(() => assertQuoteMatches(changed, input));
  }
  assert.throws(() => assertQuoteMatches(proof, { seller: 'seller', buyer: 'buyer' }));
});
test('tab storage restores only public fields and does not retain arbitrary pasted text or hidden data', () => {
  const address = '11111111111111111111111111111112';
  assert.deepEqual(savedPublicFields(JSON.stringify({ seller: address, buyer: 'seed words must never persist', mint: '<script>', price: '1e9', secretKey: 'secret' })),
    { seller: address, buyer: '', mint: '', price: '0.000001' });
  for (const raw of ['null', '[]', 'not json', '"words"']) assert.equal(savedPublicFields(raw).seller, '');
});
test('changed input or clear makes late responses unusable even when aborted fetch ignores its signal', async () => {
  const gate = requestGate(), first = gate.start();
  let resolve; const delayed = new Promise(done => resolve = done);
  const late = delayed.then(() => first.current());
  gate.invalidate(); resolve();
  assert.equal(await late, false); assert.equal(first.signal.aborted, true);
  const second = gate.start(), third = gate.start();
  assert.equal(second.current(), false); assert.equal(third.current(), true);
  gate.invalidate(); assert.equal(third.current(), false);
});
