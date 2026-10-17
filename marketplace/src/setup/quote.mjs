/** Public-account planning only. No private keys, transaction signatures or broadcasts. */
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { ACCOUNT_SIZE, MINT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { CPMM_POOL_SIZE, LOCK_ACCOUNT_SIZE, RAYDIUM_PROGRAMS, decodeCpmmPool } from '../chain/raydium.mjs';
import { parseLamports } from '../chain/settlement.mjs';
import { preflightMainnetSale } from '../verification/mainnet-sale.mjs';
import { verifyNetwork } from '../server/network.mjs';

export const SETUP_POOL = '47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4';
const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const ids = Object.fromEntries(Object.entries(RAYDIUM_PROGRAMS['mainnet-beta']).map(([name, value]) => [name, new PublicKey(value)]));
const hash = data => createHash('sha256').update(data).digest('hex');

export class SetupQuoteError extends Error {
  constructor(code, message, status = 422) { super(message); this.name = 'SetupQuoteError'; this.code = code; this.status = status; }
}
const requireThat = (condition, code, message, status) => { if (!condition) throw new SetupQuoteError(code, message, status); };
const integer = (value, label, minimum = 0) => {
  requireThat(Number.isSafeInteger(value) && value >= minimum, 'UNSAFE_RPC_NUMBER', `${label} must be a safe nonnegative RPC integer.`, 502);
  return value;
};
function address(value, label, wallet = false) {
  requireThat(typeof value === 'string' && value.length >= 32 && value.length <= 44, 'INVALID_SETUP_INPUT', `${label} must be a public address string.`, 400);
  let key;
  try { key = new PublicKey(value); } catch { throw new SetupQuoteError('INVALID_SETUP_INPUT', `${label} is not a valid public address.`, 400); }
  requireThat(key.toBase58() === value && (!wallet || PublicKey.isOnCurve(key.toBytes())), 'INVALID_SETUP_INPUT', `${label} must be a canonical ${wallet ? 'signing wallet' : 'public'} address.`, 400);
  return key;
}
function normalize(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).every(key => ['seller', 'buyer', 'feeKeyMint', 'priceLamports'].includes(key)),
  'INVALID_SETUP_INPUT', 'Supply only public seller, buyer, optional feeKeyMint and exact priceLamports. Never supply private keys.', 400);
  const seller = address(input.seller, 'Seller', true), buyer = address(input.buyer, 'Buyer', true);
  requireThat(!seller.equals(buyer), 'INVALID_SETUP_INPUT', 'Use two different wallet addresses for the controlled exchange.', 400);
  const feeKeyMint = Object.hasOwn(input, 'feeKeyMint') ? address(input.feeKeyMint, 'Fee Key mint') : null;
  let priceLamports;
  if (Object.hasOwn(input, 'priceLamports') || feeKeyMint) {
    requireThat(typeof input.priceLamports === 'string' && input.priceLamports.length <= 20,
      'INVALID_SETUP_INPUT', 'Provide an exact positive integer priceLamports string when checking a Fee Key.', 400);
    priceLamports = parseLamports(input.priceLamports).toString();
    requireThat(BigInt(priceLamports) <= 1_000_000_000_000_000n, 'INVALID_SETUP_INPUT', 'The marketplace supports prices up to 1,000,000 SOL.', 400);
  }
  return { seller, buyer, feeKeyMint, priceLamports };
}
function shape(info, owner, size, label) {
  requireThat(info && !info.executable && info.owner?.equals(owner) && info.data?.length === size,
    'INVALID_SETUP_ACCOUNT', `${label} has an unexpected owner, state or account layout.`);
}
function token(address, info, mint, owner, label, allowMissing = false) {
  if (info === null && allowMissing) return null;
  shape(info, TOKEN_PROGRAM_ID, ACCOUNT_SIZE, label);
  let value;
  try { value = unpackAccount(address, info, TOKEN_PROGRAM_ID); }
  catch { throw new SetupQuoteError('INVALID_SETUP_ACCOUNT', `${label} could not be decoded.`); }
  requireThat(value.isInitialized && !value.isFrozen && value.mint.equals(mint) && value.owner.equals(owner),
    'INVALID_SETUP_ACCOUNT', `${label} has an unexpected mint, authority or transfer state.`);
  return value;
}
function mint(address, info, label) {
  shape(info, TOKEN_PROGRAM_ID, MINT_SIZE, label);
  let value;
  try { value = unpackMint(address, info, TOKEN_PROGRAM_ID); }
  catch { throw new SetupQuoteError('INVALID_SETUP_ACCOUNT', `${label} could not be decoded.`); }
  requireThat(value.isInitialized, 'INVALID_SETUP_ACCOUNT', `${label} is not initialized.`);
  return value;
}
function balance(info, label) {
  requireThat(info === null || (info && !info.executable && info.owner?.equals(SystemProgram.programId) && info.data?.length === 0),
    'UNSUPPORTED_WALLET', `${label} must be a standard System Program wallet account.`);
  return info === null ? '0' : String(integer(info.lamports, `${label} balance`));
}
function snapshot(result, count, minimumSlot = 0) {
  requireThat(Array.isArray(result?.value) && result.value.length === count, 'MISSING_RPC_DATA', 'The finalized account snapshot is incomplete.', 502);
  const slot = integer(result.context?.slot, 'Account snapshot slot', 1);
  requireThat(slot >= minimumSlot, 'STALE_RPC_STATE', 'The RPC returned account state older than the required snapshot.', 502);
  return slot;
}
function wallets(seller, buyer, sellerInfo, buyerInfo, slot) {
  return { snapshotSlot: slot, seller: { address: seller.toBase58(), nativeBalanceLamports: balance(sellerInfo, 'Seller') },
    buyer: { address: buyer.toBase58(), nativeBalanceLamports: balance(buyerInfo, 'Buyer') } };
}
function base(genesisHash, mode) {
  return { schemaVersion: 1, kind: 'sona-setup-quote', mode, readOnly: true, networkWrites: 0, transactionsSent: 0,
    cluster: 'mainnet-beta', genesisHash, commitment: 'finalized', observedAt: new Date().toISOString() };
}

async function existingKey(connection, values, genesisHash) {
  const { seller, buyer, feeKeyMint, priceLamports } = values;
  const held = await connection.getTokenAccountsByOwner(seller, { mint: feeKeyMint }, { commitment: 'finalized' });
  requireThat(Array.isArray(held?.value) && held.value.length <= 32, 'INVALID_HOLDER_RESPONSE', 'Fee Key account discovery returned an unsupported or incomplete result.', 502);
  const heldSlot = integer(held.context?.slot, 'Holder discovery slot', 1);
  const matches = held.value.filter(entry => {
    try { return token(entry.pubkey, entry.account, feeKeyMint, seller, 'Fee Key holder').amount === 1n; }
    catch (error) { if (error instanceof SetupQuoteError) return false; throw error; }
  });
  requireThat(matches.length === 1, 'NOT_HELD', 'The seller does not hold exactly one supported Fee Key token.');
  const sourceTokenAccount = matches[0].pubkey.toBase58();
  const settlement = await preflightMainnetSale({ connection, terms: { seller: seller.toBase58(), buyer: buyer.toBase58(),
    mint: feeKeyMint.toBase58(), sourceTokenAccount, priceLamports } });
  requireThat(settlement.feeKey.slot >= heldSlot, 'STALE_RPC_STATE', 'The Fee Key verification predates holder discovery.', 502);
  const accounts = await connection.getMultipleAccountsInfoAndContext([seller, buyer], { commitment: 'finalized', minContextSlot: settlement.snapshotSlot });
  const slot = snapshot(accounts, 2, settlement.snapshotSlot);
  const proof = settlement.feeKey;
  return { ...base(genesisHash, 'existing-fee-key'), wallets: wallets(seller, buyer, ...accounts.value, slot),
    pool: { address: proof.poolId, lpMint: proof.lpMint, mintA: proof.mintA, mintB: proof.mintB, lpDecimals: proof.lpDecimals,
      slot: proof.slot, verified: true, protocol: 'raydium-cpmm', suggestedCreationPool: false, evidence: proof.evidence },
    creation: null, settlement,
    statement: 'An existing eligible Fee Key can skip liquidity deposit and locking. Balances and the settlement preflight have their own finalized observation slots; neither is a signed transaction or a guarantee of later execution.' };
}

async function creationPlan(connection, { seller, buyer }, genesisHash) {
  const poolKey = new PublicKey(SETUP_POOL);
  const initial = await connection.getMultipleAccountsInfoAndContext([poolKey], { commitment: 'finalized' });
  const firstSlot = snapshot(initial, 1);
  shape(initial.value[0], ids.cpmm, CPMM_POOL_SIZE, 'Suggested CPMM pool');
  const first = decodeCpmmPool(initial.value[0].data);
  const lp = PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'), poolKey.toBuffer()], ids.cpmm)[0];
  const vault = value => PublicKey.findProgramAddressSync([Buffer.from('pool_vault'), poolKey.toBuffer(), value.toBuffer()], ids.cpmm)[0];
  const solVault = vault(SOL), usdcVault = vault(USDC);
  const escrow = getAssociatedTokenAddressSync(lp, ids.lockAuthority, true);
  const atas = { sol: getAssociatedTokenAddressSync(SOL, seller), usdc: getAssociatedTokenAddressSync(USDC, seller), lp: getAssociatedTokenAddressSync(lp, seller) };
  // Validate identity before reading any pool-supplied addresses. Only pinned or derived addresses are queried.
  const validPool = pool => pool.lpMint.equals(lp) && pool.mintProgramA.equals(TOKEN_PROGRAM_ID) && pool.mintProgramB.equals(TOKEN_PROGRAM_ID)
    && ((pool.mintA.equals(SOL) && pool.mintB.equals(USDC) && pool.vaultA.equals(solVault) && pool.vaultB.equals(usdcVault))
      || (pool.mintA.equals(USDC) && pool.mintB.equals(SOL) && pool.vaultA.equals(usdcVault) && pool.vaultB.equals(solVault)));
  requireThat(validPool(first), 'INVALID_SETUP_POOL', 'The suggested pool is not the expected canonical SOL/USDC CPMM pool.');
  // Keep free-RPC batches small. Pool linkage is authenticated in one context;
  // balances are a separate, explicitly recorded context at or after that slot.
  const keys = [poolKey, lp, SOL, USDC, solVault, usdcVault, escrow];
  const [state, mintRent, tokenRent, lockRent] = await Promise.all([
    connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot: firstSlot }),
    connection.getMinimumBalanceForRentExemption(MINT_SIZE, 'finalized'),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'finalized'),
    connection.getMinimumBalanceForRentExemption(LOCK_ACCOUNT_SIZE, 'finalized'),
  ]);
  const poolSlot = snapshot(state, keys.length, firstSlot);
  const [poolInfo, lpInfo, solInfo, usdcInfo, solVaultInfo, usdcVaultInfo, escrowInfo] = state.value;
  shape(poolInfo, ids.cpmm, CPMM_POOL_SIZE, 'Suggested CPMM pool');
  const pool = decodeCpmmPool(poolInfo.data);
  requireThat(validPool(pool), 'INVALID_SETUP_POOL', 'The suggested pool linkage changed during verification.');
  const lpState = mint(lp, lpInfo, 'Pool LP mint'), solState = mint(SOL, solInfo, 'Wrapped SOL mint'), usdcState = mint(USDC, usdcInfo, 'USDC mint');
  requireThat(lpState.decimals === pool.lpDecimals && lpState.supply > 0n && lpState.mintAuthority?.equals(ids.cpmmAuthority) && !lpState.freezeAuthority,
    'INVALID_SETUP_POOL', 'The suggested pool LP mint has unexpected supply, decimals or authorities.');
  requireThat(solState.decimals === 9 && usdcState.decimals === 6 && (pool.mintA.equals(SOL)
    ? pool.mintDecimalsA === 9 && pool.mintDecimalsB === 6 : pool.mintDecimalsA === 6 && pool.mintDecimalsB === 9),
  'INVALID_SETUP_POOL', 'The suggested pool has unexpected token decimals.');
  token(solVault, solVaultInfo, SOL, ids.cpmmAuthority, 'SOL pool vault');
  token(usdcVault, usdcVaultInfo, USDC, ids.cpmmAuthority, 'USDC pool vault');
  const lpEscrow = token(escrow, escrowInfo, lp, ids.lockAuthority, 'Raydium LP escrow', true);
  const walletState = await connection.getMultipleAccountsInfoAndContext([seller, buyer, atas.sol, atas.usdc, atas.lp],
    { commitment: 'finalized', minContextSlot: poolSlot });
  const walletSlot = snapshot(walletState, 5, poolSlot);
  const [sellerInfo, buyerInfo, ...ataInfos] = walletState.value;
  const rent = { mint: String(integer(mintRent, 'Mint rent', 1)), tokenAccount: String(integer(tokenRent, 'Token-account rent', 1)),
    lockAccount: String(integer(lockRent, 'Lock-account rent', 1)) };
  const sellerTokenAccounts = Object.fromEntries(Object.entries(atas).map(([name, key], index) => {
    const mintKey = name === 'sol' ? SOL : name === 'usdc' ? USDC : lp;
    const value = token(key, ataInfos[index], mintKey, seller, `Seller ${name} token account`, true);
    return [name, { address: key.toBase58(), mint: mintKey.toBase58(), exists: value !== null, amount: value?.amount.toString() ?? '0',
      decimals: name === 'sol' ? 9 : name === 'usdc' ? 6 : pool.lpDecimals,
      delegated: !!value?.delegate, thirdPartyCloseAuthority: !!value?.closeAuthority && !value.closeAuthority.equals(seller) }];
  }));
  const lockAccountRent = { feeKeyMint: rent.mint, feeKeyTokenAccount: rent.tokenAccount, lockAccount: rent.lockAccount,
    lpEscrow: lpEscrow ? '0' : rent.tokenAccount };
  lockAccountRent.knownSubtotalLamports = Object.values(lockAccountRent).reduce((sum, value) => sum + BigInt(value), 0n).toString();
  const evidence = { commitment: 'finalized', snapshotSlot: poolSlot, accounts: Object.fromEntries(keys.map((key, index) => [key.toBase58(), state.value[index] === null ? null : {
    owner: state.value[index].owner.toBase58(), bytes: state.value[index].data.length, sha256: hash(state.value[index].data),
  }])) };
  return { ...base(genesisHash, 'create-fee-key'), wallets: wallets(seller, buyer, sellerInfo, buyerInfo, walletSlot),
    pool: { address: SETUP_POOL, lpMint: lp.toBase58(), mintA: pool.mintA.toBase58(), mintB: pool.mintB.toBase58(), lpDecimals: pool.lpDecimals,
      slot: poolSlot, verified: true, protocol: 'raydium-cpmm', suggestedCreationPool: true, status: pool.status, evidence },
    creation: { snapshotSlot: walletSlot, poolSnapshotSlot: poolSlot, walletSnapshotSlot: walletSlot, sellerTokenAccounts, rentExemptionLamports: rent, lockAccountRent,
      missingSellerTokenAccountRentLamports: Object.values(sellerTokenAccounts).reduce((sum, account) => sum + (account.exists ? 0n : BigInt(rent.tokenAccount)), 0n).toString(),
      depositPrincipal: null, transactionFeesLamports: null, metadataCostLamports: null, allInCostLamports: null,
      principalIsPermanentlyLocked: true, unknownCosts: [
        'The deposit amounts, LP amount and slippage must be quoted by Raydium before approval; permanently locking LP makes its principal unwithdrawable.',
        'Deposit and lock transaction fees, priority fees and any protocol or optional metadata charges are not quoted until the actual transactions are built.',
        'Missing seller token-account rent is conditional: Raydium may reuse other accounts or use a temporary wrapped-SOL account. The listed balances cover canonical token accounts only.',
      ] }, settlement: null,
    statement: 'This verifies the suggested existing pool and reports observed balances and current rent components. Pool accounts and wallet balances are separate finalized snapshots with their respective slots, not one atomic observation. It is not an all-in funding quote, deposit quote, lock authorization or a promise that the pool currently accepts a deposit. No wallet is created and no funds are moved.' };
}

/** Input is public information only. Arbitrary RPC URLs and pool addresses are never accepted. */
export async function quoteSetup({ connection, input }) {
  const values = normalize(input);
  const genesisHash = await verifyNetwork(connection, 'mainnet-beta');
  return values.feeKeyMint ? existingKey(connection, values, genesisHash) : creationPlan(connection, values, genesisHash);
}
