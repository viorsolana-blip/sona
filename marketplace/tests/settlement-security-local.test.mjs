import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { AuthorityType, approve, revoke, setAuthority, getAccount,
  getOrCreateAssociatedTokenAccount, createTransferCheckedInstruction } from '@solana/spl-token';
import { runSettlementLocal } from '../scripts/test-settlement-local.mjs';
import { buildSettlementTransaction, inspectSettlementAsset, prepareSettlement } from '../src/chain/settlement.mjs';

test('real validator reproduces a retained destination delegate and proves preparation rejects it', {
  skip: process.env.SONA_LOCAL_VALIDATOR_TESTS !== '1', timeout: 240000,
}, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sona-chain-review-'));
  const cases = [];
  try {
    const baseline = await runSettlementLocal({ outputPath: join(temporary, 'baseline.json'),
      async runBackend({ connection, seller, buyer, other, nft, genesisWallet }) {
        const asset = await nft();
        const target = await getOrCreateAssociatedTokenAccount(connection, genesisWallet, asset.mint, buyer.publicKey);
        await approve(connection, genesisWallet, target.address, other.publicKey, buyer, 1n);
        assert.equal((await getAccount(connection, target.address)).amount, 0n);
        const terms = { ...asset, seller: seller.publicKey, buyer: buyer.publicKey, priceLamports: '1' };
        await assert.rejects(inspectSettlementAsset({ connection, ...terms }), { code: 'UNSAFE_DESTINATION' });

        // Deliberately bypass the new service guard on isolated test state to
        // establish that the SPL program really retains the old permission.
        // These valueless NFT fixtures are not represented as Raydium Fee Keys.
        const built = buildSettlementTransaction({ ...terms, ...await connection.getLatestBlockhash('confirmed') });
        const transferSignature = await sendAndConfirmTransaction(connection, built.transaction, [buyer, seller]);
        const received = await getAccount(connection, target.address);
        assert.equal(received.amount, 1n); assert(received.delegate.equals(other.publicKey));
        const otherTarget = await getOrCreateAssociatedTokenAccount(connection, genesisWallet, asset.mint, other.publicKey);
        const delegatedTransfer = new Transaction().add(createTransferCheckedInstruction(target.address, asset.mint,
          otherTarget.address, other.publicKey, 1n, 0));
        const delegatedTransferSignature = await sendAndConfirmTransaction(connection, delegatedTransfer, [genesisWallet, other]);
        assert.equal((await getAccount(connection, target.address)).amount, 0n);
        assert.equal((await getAccount(connection, otherTarget.address)).amount, 1n);
        cases.push({ name: 'an old buyer-approved delegate can transfer a newly received NFT from an existing empty ATA', passed: true,
          exploitPrerequisite: 'Buyer previously authorized the third-party delegate on this exact mint ATA.',
          guardResult: 'UNSAFE_DESTINATION', transferSignature, delegatedTransferSignature });

        const safeAsset = await nft();
        const safeTarget = await getOrCreateAssociatedTokenAccount(connection, genesisWallet, safeAsset.mint, buyer.publicKey);
        const input = { connection, buyer: buyer.publicKey,
          listing: { ...safeAsset, seller: seller.publicKey, priceLamports: '1' },
          verifyFeeKey: async () => ({ verified: true, mint: safeAsset.mint }) };
        await approve(connection, genesisWallet, safeTarget.address, other.publicKey, buyer, 1n);
        await assert.rejects(prepareSettlement(input), { code: 'UNSAFE_DESTINATION' });
        await revoke(connection, genesisWallet, safeTarget.address, buyer);
        await setAuthority(connection, genesisWallet, safeTarget.address, buyer, AuthorityType.CloseAccount, other.publicKey);
        await assert.rejects(prepareSettlement(input), { code: 'UNSAFE_DESTINATION' });
        await setAuthority(connection, genesisWallet, safeTarget.address, other, AuthorityType.CloseAccount, null);
        const approved = await prepareSettlement(input);
        assert.equal(approved.destinationTokenAccount, safeTarget.address.toBase58());
        cases.push({ name: 'real ATA delegate and foreign close authority block preparation; revoking both permits construction', passed: true,
          raydiumVerifier: 'Explicit local SPL fixture stub; not Raydium authenticity evidence.' });
      },
    });
    const sourceSha256 = {};
    for (const path of ['src/chain/settlement.mjs', 'tests/settlement-security.test.mjs', 'tests/settlement-security-local.test.mjs']) {
      sourceSha256[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
    }
    const report = { schema: 'sona-security-destination-local-v1', generatedAt: new Date().toISOString(),
      reviewType: 'Internal AI-assisted security review; not an independent audit.',
      environment: baseline.environment, validator: baseline.validator, privateKeysPersisted: false,
      scope: 'Real SPL delegated-transfer reproduction and off-chain destination-state rejection. No mainnet transaction, Raydium mint, or independent audit is claimed.',
      residualRisk: 'A buyer can grant new permissions after the state check. This check is not an on-chain guard and does not revoke user permissions.',
      baselineSettlementCasesPassed: baseline.passed, cases, passed: cases.length, failed: 0, sourceSha256 };
    await writeFile(new URL('../evidence/security-destination-local.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
