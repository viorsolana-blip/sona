import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, MINT_SIZE,
  getAssociatedTokenAddressSync, unpackAccount, unpackMint,
} from '@solana/spl-token';

// These are protocol addresses, not configurable trust roots. See evidence/RAYDIUM-SOURCES.md.
export const RAYDIUM_PROGRAMS = Object.freeze({
  'mainnet-beta': Object.freeze({
    lock: 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE',
    lockAuthority: '3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH',
    cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
    cpmmAuthority: 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL',
  }),
  devnet: Object.freeze({
    lock: 'DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX',
    lockAuthority: '7qWVV8UY2bRJfDLP4s37YzBPKUkVB46DStYJBpYbQzu3',
    cpmm: 'DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb',
    cpmmAuthority: 'CXniRufdq5xL8t8jZAPxsPZDpuudwuJSPWnbcD5Y5Nxq',
  }),
});

export const LOCK_ACCOUNT_SIZE = 256;
export const CPMM_POOL_SIZE = 637;
export const LOCK_DISCRIMINATOR = Buffer.from([25, 10, 238, 197, 207, 234, 73, 22]);
export const POOL_DISCRIMINATOR = Buffer.from([247, 237, 227, 245, 215, 195, 222, 70]);

export class RaydiumEligibilityError extends Error {
  constructor(code, message) { super(message); this.name = 'RaydiumEligibilityError'; this.code = code; }
}
function fail(code, message) { throw new RaydiumEligibilityError(code, message); }
function requireThat(condition, code, message) { if (!condition) fail(code, message); }
function key(value, label = 'Address') {
  try { return new PublicKey(value); }
  catch { fail('INVALID_ADDRESS', `${label} must be a Solana public key.`); }
}
function programs(cluster) {
  const value = RAYDIUM_PROGRAMS[cluster];
  if (!value) fail('UNSUPPORTED_CLUSTER', 'Only mainnet-beta and devnet Fee Keys are supported.');
  return Object.fromEntries(Object.entries(value).map(([name, value]) => [name, new PublicKey(value)]));
}
function readKey(data, offset) { return new PublicKey(data.subarray(offset, offset + 32)); }
function accountShape(account, owner, size, code) {
  requireThat(account && !account.executable && account.owner.equals(owner), code, 'Account has an unexpected program owner or does not exist.');
  requireThat(account.data.length === size, code, 'Account uses an unsupported layout.');
}
function digest(account) { return createHash('sha256').update(account.data).digest('hex'); }
function readConfig(commitment, minContextSlot) {
  requireThat(commitment === 'confirmed' || commitment === 'finalized', 'UNSUPPORTED_COMMITMENT', 'Fee Key verification requires confirmed or finalized state.');
  return { commitment, ...(minContextSlot === undefined ? {} : { minContextSlot }) };
}

export function deriveLockAddress(mint, cluster = 'mainnet-beta') {
  return PublicKey.findProgramAddressSync([Buffer.from('locked_liquidity'), key(mint).toBuffer()], programs(cluster).lock)[0];
}

export function decodeLockedLiquidity(data) {
  data = Buffer.from(data);
  requireThat(data.length === LOCK_ACCOUNT_SIZE, 'INVALID_LOCK_LAYOUT', 'Unsupported Raydium lock account length.');
  requireThat(data.subarray(0, 8).equals(LOCK_DISCRIMINATOR), 'INVALID_LOCK_DISCRIMINATOR', 'Account is not a CPMM liquidity lock.');
  return {
    lockedLpAmount: data.readBigUInt64LE(8), claimedLpAmount: data.readBigUInt64LE(16),
    unclaimedLpAmount: data.readBigUInt64LE(24), lastLp: data.readBigUInt64LE(32),
    lastK: data.readBigUInt64LE(40) + (data.readBigUInt64LE(48) << 64n),
    recentEpoch: data.readBigUInt64LE(56), poolId: readKey(data, 64),
    feeNftMint: readKey(data, 96), originalLockOwner: readKey(data, 128), lpMint: readKey(data, 160),
  };
}

export function decodeCpmmPool(data) {
  data = Buffer.from(data);
  requireThat(data.length === CPMM_POOL_SIZE, 'INVALID_POOL_LAYOUT', 'Unsupported Raydium CPMM pool layout.');
  requireThat(data.subarray(0, 8).equals(POOL_DISCRIMINATOR), 'INVALID_POOL_DISCRIMINATOR', 'Account is not a Raydium CPMM pool.');
  return {
    config: readKey(data, 8), creator: readKey(data, 40), vaultA: readKey(data, 72), vaultB: readKey(data, 104),
    lpMint: readKey(data, 136), mintA: readKey(data, 168), mintB: readKey(data, 200),
    mintProgramA: readKey(data, 232), mintProgramB: readKey(data, 264), observation: readKey(data, 296),
    status: data[329], lpDecimals: data[330], mintDecimalsA: data[331], mintDecimalsB: data[332],
    lpSupply: data.readBigUInt64LE(333),
  };
}

function readToken(address, account, errorCode = 'INVALID_TOKEN_ACCOUNT') {
  accountShape(account, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, errorCode);
  try { return unpackAccount(address, account, TOKEN_PROGRAM_ID); }
  catch { fail(errorCode, 'Token account could not be decoded.'); }
}
function readMint(address, account, errorCode = 'INVALID_MINT') {
  accountShape(account, TOKEN_PROGRAM_ID, MINT_SIZE, errorCode);
  try { return unpackMint(address, account, TOKEN_PROGRAM_ID); }
  catch { fail(errorCode, 'Mint account could not be decoded.'); }
}

/** Authenticate an existing Fee Key using RPC account state, never its name or metadata.
 * No transaction is signed or submitted. owner must be the CURRENT holder; locked_owner
 * is historical and deliberately not compared with owner because Fee Keys transfer.
 * The final eight-account read gives one RPC context for all eligibility checks.
 */
export async function verifyFeeKey({ connection, cluster = 'mainnet-beta', mint, owner, tokenAccount, commitment = 'confirmed', minContextSlot }) {
  const ids = programs(cluster), mintKey = key(mint, 'Mint'), ownerKey = key(owner, 'Owner');
  const config = readConfig(commitment, minContextSlot);
  const lockKey = deriveLockAddress(mintKey, cluster);
  let tokenKey;
  if (tokenAccount) tokenKey = key(tokenAccount, 'Token account');
  else {
    const holdings = await connection.getTokenAccountsByOwner(ownerKey, { mint: mintKey }, config);
    const matches = holdings.value.filter(({ pubkey, account }) => {
      try {
        const token = readToken(pubkey, account);
        return token.mint.equals(mintKey) && token.owner.equals(ownerKey) && token.amount === 1n;
      } catch (error) { if (error instanceof RaydiumEligibilityError) return false; throw error; }
    });
    requireThat(matches.length === 1, 'NOT_HELD', 'The wallet does not hold exactly one supported Fee Key token.');
    tokenKey = matches[0].pubkey;
    config.minContextSlot = Math.max(config.minContextSlot ?? 0, holdings.context.slot);
  }
  const first = await connection.getMultipleAccountsInfoAndContext([lockKey], config);
  accountShape(first.value[0], ids.lock, LOCK_ACCOUNT_SIZE, 'NOT_RAYDIUM_FEE_KEY');
  const initialLock = decodeLockedLiquidity(first.value[0].data);
  requireThat(initialLock.feeNftMint.equals(mintKey), 'LOCK_MINT_MISMATCH', 'Fee Key does not match the canonical Raydium lock.');
  const second = await connection.getMultipleAccountsInfoAndContext([initialLock.poolId], { ...config, minContextSlot: first.context.slot });
  accountShape(second.value[0], ids.cpmm, CPMM_POOL_SIZE, 'INVALID_POOL');
  const initialPool = decodeCpmmPool(second.value[0].data);
  const escrowKey = getAssociatedTokenAddressSync(initialPool.lpMint, ids.lockAuthority, true);
  const addresses = [mintKey, tokenKey, lockKey, initialLock.poolId, initialPool.lpMint, escrowKey, initialPool.vaultA, initialPool.vaultB];
  const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses, { ...config, minContextSlot: second.context.slot });
  const [mintAccount, holderAccount, lockAccount, poolAccount, lpAccount, escrowAccount, vaultAAccount, vaultBAccount] = snapshot.value;
  accountShape(lockAccount, ids.lock, LOCK_ACCOUNT_SIZE, 'NOT_RAYDIUM_FEE_KEY');
  accountShape(poolAccount, ids.cpmm, CPMM_POOL_SIZE, 'INVALID_POOL');
  const lock = decodeLockedLiquidity(lockAccount.data), pool = decodeCpmmPool(poolAccount.data);
  requireThat(lock.feeNftMint.equals(mintKey) && lock.poolId.equals(initialLock.poolId) && pool.lpMint.equals(initialPool.lpMint), 'LOCK_CHANGED', 'The position linkage changed during verification.');
  requireThat(lock.lockedLpAmount > 0n, 'EMPTY_LOCK', 'The lock has no remaining locked liquidity.');
  requireThat(lock.lpMint.equals(pool.lpMint), 'LP_MINT_MISMATCH', 'The lock LP mint does not match the authenticated pool.');
  const canonicalLp = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), lock.poolId.toBuffer()], ids.cpmm)[0];
  requireThat(pool.lpMint.equals(canonicalLp), 'LP_MINT_MISMATCH', 'The pool LP mint is not its canonical PDA.');
  const nft = readMint(mintKey, mintAccount);
  requireThat(nft.isInitialized && nft.decimals === 0 && nft.supply === 1n, 'NOT_UNIQUE_NFT', 'Fee Key must be an initialized, indivisible, unique SPL NFT.');
  requireThat(nft.mintAuthority === null && nft.freezeAuthority === null, 'MUTABLE_NFT', 'Fee Key mint and freeze authorities must be revoked.');
  const holder = readToken(tokenKey, holderAccount);
  requireThat(holder.owner.equals(ownerKey) && holder.mint.equals(mintKey) && holder.amount === 1n && holder.isInitialized && !holder.isFrozen, 'NOT_HELD', 'The wallet does not hold a transferable Fee Key in this account.');
  requireThat(holder.delegate === null, 'DELEGATED_NFT', 'Revoke the Fee Key delegate before listing it.');
  const lp = readMint(pool.lpMint, lpAccount, 'INVALID_LP_MINT');
  requireThat(lp.isInitialized && lp.decimals === pool.lpDecimals && lp.supply > 0n && lp.mintAuthority?.equals(ids.cpmmAuthority) && lp.freezeAuthority === null, 'INVALID_LP_MINT', 'The pool LP mint has invalid supply, decimals or authorities.');
  const escrow = readToken(escrowKey, escrowAccount, 'INVALID_LP_ESCROW');
  requireThat(escrow.owner.equals(ids.lockAuthority) && escrow.mint.equals(pool.lpMint) && escrow.isInitialized && !escrow.isFrozen && escrow.amount >= lock.lockedLpAmount, 'INVALID_LP_ESCROW', 'Raydium escrow does not hold the recorded locked LP amount.');
  // Pool tokens may legitimately be Token-2022; NFT settlement itself only accepts legacy SPL.
  for (const [label, address, account, tokenMint, tokenProgram] of [
    ['A', initialPool.vaultA, vaultAAccount, pool.mintA, pool.mintProgramA],
    ['B', initialPool.vaultB, vaultBAccount, pool.mintB, pool.mintProgramB],
  ]) {
    requireThat(tokenProgram.equals(TOKEN_PROGRAM_ID) || tokenProgram.equals(TOKEN_2022_PROGRAM_ID), 'UNSUPPORTED_POOL_TOKEN_PROGRAM', 'Pool tokens must use a recognized SPL token program.');
    const currentAddress = label === 'A' ? pool.vaultA : pool.vaultB;
    const canonical = PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), lock.poolId.toBuffer(), tokenMint.toBuffer()], ids.cpmm)[0];
    requireThat(currentAddress.equals(address) && canonical.equals(address) && account && account.owner.equals(tokenProgram) && !account.executable, 'INVALID_POOL_VAULT', `Pool vault ${label} is not canonical.`);
    let vault;
    try { vault = unpackAccount(address, account, tokenProgram); }
    catch { fail('INVALID_POOL_VAULT', `Pool vault ${label} could not be decoded.`); }
    requireThat(vault.mint.equals(tokenMint) && vault.owner.equals(ids.cpmmAuthority) && vault.isInitialized && !vault.isFrozen, 'INVALID_POOL_VAULT', `Pool vault ${label} has invalid mint, authority or state.`);
  }
  const proofAccounts = Object.fromEntries(addresses.map((address, index) => [address.toBase58(), {
    owner: snapshot.value[index].owner.toBase58(), bytes: snapshot.value[index].data.length, sha256: digest(snapshot.value[index]),
  }]));
  return {
    verified: true, id: mintKey.toBase58(), mint: mintKey.toBase58(), owner: ownerKey.toBase58(),
    tokenAccount: tokenKey.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    lockAccount: lockKey.toBase58(), poolId: lock.poolId.toBase58(), lpMint: pool.lpMint.toBase58(),
    lockedLpAmount: lock.lockedLpAmount.toString(), lpDecimals: pool.lpDecimals,
    mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(),
    mintProgramA: pool.mintProgramA.toBase58(), mintProgramB: pool.mintProgramB.toBase58(),
    originalLockOwner: lock.originalLockOwner.toBase58(),
    slot: snapshot.context.slot, cluster, protocol: 'raydium-cpmm', kind: 'fee-rights',
    evidence: { commitment, lockProgram: ids.lock.toBase58(), poolProgram: ids.cpmm.toBase58(), escrow: escrowKey.toBase58(), accounts: proofAccounts },
  };
}

/** Wallet discovery uses small direct account reads; no DAS, metadata service or API key.
 * RPC errors propagate. Only explicit ineligibility is returned as a rejection.
 * A visible truncation indicator is returned for wallets beyond the bounded scan.
 */
export async function discoverFeeKeys({ connection, owner, cluster = 'mainnet-beta', commitment = 'confirmed', maxCandidates = 200, maxVerificationCalls = 500 }) {
  programs(cluster);
  const ownerKey = key(owner, 'Owner');
  requireThat(Number.isInteger(maxCandidates) && maxCandidates >= 1 && maxCandidates <= 500, 'INVALID_LIMIT', 'Candidate limit must be between 1 and 500.');
  requireThat(Number.isInteger(maxVerificationCalls) && maxVerificationCalls >= 1 && maxVerificationCalls <= 500, 'INVALID_LIMIT', 'Verification limit must be between 1 and 500.');
  const holdings = await connection.getTokenAccountsByOwner(ownerKey, { programId: TOKEN_PROGRAM_ID }, readConfig(commitment));
  const allCandidates = [];
  for (const { pubkey, account } of holdings.value) {
    try {
      const token = readToken(pubkey, account);
      if (token.amount === 1n && token.owner.equals(ownerKey)) allCandidates.push({ mint: token.mint, tokenAccount: pubkey });
    } catch (error) { if (!(error instanceof RaydiumEligibilityError)) throw error; }
  }
  const candidates = allCandidates.slice(0, maxCandidates), positions = [], rejected = [];
  let slot = holdings.context.slot, verificationCalls = 0, deferredCandidates = 0;
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const locks = await connection.getMultipleAccountsInfoAndContext(batch.map(({ mint }) => deriveLockAddress(mint, cluster)), readConfig(commitment, slot));
    slot = Math.max(slot, locks.context.slot);
    for (let i = 0; i < batch.length; i++) {
      // Most one-unit tokens are unrelated to Raydium; absent lock PDAs are not errors.
      if (!locks.value[i]) continue;
      // Scan unrelated NFT-like tokens cheaply in batches before spending the
      // deeper account-read budget on candidate Raydium locks. A partial scan is
      // explicit, including when more genuine candidates remain after the cap.
      if (verificationCalls >= maxVerificationCalls) { deferredCandidates++; continue; }
      verificationCalls++;
      try {
        const position = await verifyFeeKey({ connection, owner: ownerKey, cluster, commitment, minContextSlot: slot, ...batch[i] });
        positions.push(position); slot = Math.max(slot, position.slot);
      } catch (error) {
        if (!(error instanceof RaydiumEligibilityError)) throw error;
        rejected.push({ mint: batch[i].mint.toBase58(), code: error.code, reason: error.message });
      }
    }
  }
  return { positions, rejected, slot, cluster, scannedCandidates: candidates.length, totalCandidates: allCandidates.length,
    verificationCalls, deferredCandidates, truncated: allCandidates.length > candidates.length || deferredCandidates > 0 };
}
