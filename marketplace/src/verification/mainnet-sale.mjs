/** Read-only evidence verification. This module never signs or broadcasts. */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { buildSettlementTransaction, parseLamports, verifyCanonicalSignedTransaction } from '../chain/settlement.mjs';
import { verifyFeeKey } from '../chain/raydium.mjs';
import { verifyNetwork } from '../server/network.mjs';

export class MainnetVerificationError extends Error {
  constructor(code, message) { super(message); this.name = 'MainnetVerificationError'; this.code = code; }
}
const fail = (code, message) => { throw new MainnetVerificationError(code, message); };
const requireThat = (condition, code, message) => { if (!condition) fail(code, message); };
const safeInteger = (value, label, minimum = 0) => {
  requireThat(Number.isSafeInteger(value) && value >= minimum, 'UNSAFE_RPC_NUMBER', `${label} is missing or is not a safe nonnegative RPC integer.`);
  return value;
};
const lamports = (value, label) => BigInt(safeInteger(value, label));
const address = (value, label) => {
  requireThat(typeof value === 'string', 'INVALID_TERMS', `${label} must be a public address string.`);
  let key;
  try { key = new PublicKey(value); } catch { fail('INVALID_TERMS', `${label} is not a public address.`); }
  requireThat(key.toBase58() === value, 'INVALID_TERMS', `${label} must use canonical base58 encoding.`);
  return key;
};
const termFields = ['mint', 'seller', 'buyer', 'sourceTokenAccount', 'priceLamports'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const iso = () => new Date().toISOString();

export function normalizeSaleTerms(input) {
  requireThat(input && typeof input === 'object' && !Array.isArray(input)
    && termFields.every(field => Object.hasOwn(input, field))
    && Object.keys(input).every(field => termFields.includes(field) || field === 'destinationTokenAccount'),
  'INVALID_TERMS', 'Provide only public sale terms and an optional derived destinationTokenAccount. Never supply private keys.');
  const keys = Object.fromEntries(termFields.filter(field => field !== 'priceLamports').map(field => [field, address(input[field], field)]));
  requireThat(PublicKey.isOnCurve(keys.seller.toBytes()) && PublicKey.isOnCurve(keys.buyer.toBytes()), 'INVALID_TERMS', 'Buyer and seller must be signing wallet addresses.');
  requireThat(new Set(Object.values(keys).map(String)).size === 4, 'INVALID_TERMS', 'Buyer, seller, mint and source must be distinct addresses.');
  requireThat(typeof input.priceLamports === 'string', 'INVALID_TERMS', 'priceLamports must be an exact positive integer string.');
  const priceLamports = parseLamports(input.priceLamports).toString();
  const destinationTokenAccount = getAssociatedTokenAddressSync(keys.mint, keys.buyer, false, TOKEN_PROGRAM_ID).toBase58();
  if (Object.hasOwn(input, 'destinationTokenAccount')) requireThat(input.destinationTokenAccount === destinationTokenAccount,
    'INVALID_TERMS', 'Supplied destinationTokenAccount does not match the derived buyer ATA.');
  requireThat(destinationTokenAccount !== input.sourceTokenAccount, 'INVALID_TERMS', 'Seller source must differ from the buyer destination.');
  return { ...Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, value.toBase58()])), priceLamports, destinationTokenAccount };
}

function checkedFeeKey(proof, terms, holder, tokenAccount, minimumSlot = 0) {
  requireThat(proof?.verified === true && proof.cluster === 'mainnet-beta' && proof.evidence?.commitment === 'finalized'
    && proof.mint === terms.mint && proof.owner === holder && proof.tokenAccount === tokenAccount,
  'INVALID_FEE_KEY_PROOF', 'Finalized Raydium proof does not match the expected mint and holder.');
  requireThat(safeInteger(proof.slot, 'Raydium slot', 1) >= minimumSlot, 'STALE_RPC_STATE', 'Raydium account state predates the transaction.');
  return proof;
}

function checkedDestination(info, terms) {
  if (info === null) return false;
  requireThat(info && !info.executable && info.owner?.equals(TOKEN_PROGRAM_ID) && info.data?.length === ACCOUNT_SIZE,
    'UNSAFE_DESTINATION', 'Buyer ATA has an unsupported owner or layout.');
  let token;
  try { token = unpackAccount(new PublicKey(terms.destinationTokenAccount), info, TOKEN_PROGRAM_ID); }
  catch { fail('UNSAFE_DESTINATION', 'Buyer ATA could not be decoded.'); }
  requireThat(token.isInitialized && !token.isFrozen && token.amount === 0n
    && token.owner.toBase58() === terms.buyer && token.mint.toBase58() === terms.mint
    && !token.delegate && (!token.closeAuthority || token.closeAuthority.toBase58() === terms.buyer),
  'UNSAFE_DESTINATION', 'Buyer ATA must be empty, transferable and free of third-party delegates or close authority.');
  safeInteger(info.lamports, 'Buyer ATA lamports');
  return true;
}

/** A dated eligibility/cost estimate; not a trade, authorization or funding request. */
export async function preflightMainnetSale({ connection, terms: input }) {
  const terms = normalizeSaleTerms(input);
  const genesisHash = await verifyNetwork(connection, 'mainnet-beta');
  const feeKey = checkedFeeKey(await verifyFeeKey({ connection, cluster: 'mainnet-beta', commitment: 'finalized',
    mint: terms.mint, owner: terms.seller, tokenAccount: terms.sourceTokenAccount }), terms, terms.seller, terms.sourceTokenAccount);
  const config = { commitment: 'finalized', minContextSlot: feeKey.slot };
  const accounts = await connection.getMultipleAccountsInfoAndContext([
    new PublicKey(terms.destinationTokenAccount), new PublicKey(terms.buyer), new PublicKey(terms.seller),
  ], config);
  requireThat(Array.isArray(accounts?.value) && accounts.value.length === 3, 'MISSING_RPC_DATA', 'Wallet account snapshot is incomplete.');
  const snapshotSlot = safeInteger(accounts.context?.slot, 'Wallet snapshot slot', 1);
  requireThat(snapshotSlot >= feeKey.slot, 'STALE_RPC_STATE', 'Wallet account snapshot predates Fee Key verification.');
  const [destination, buyer, seller] = accounts.value;
  const destinationExists = checkedDestination(destination, terms);
  for (const [label, info] of [['Buyer', buyer], ['Seller', seller]]) {
    requireThat(info === null || (info && !info.executable && info.owner?.equals(SystemProgram.programId) && info.data?.length === 0),
      'UNSUPPORTED_WALLET', `${label} must be a standard System Program wallet account.`);
    if (info) safeInteger(info.lamports, `${label} balance`);
  }
  const buyerBalance = buyer === null ? 0n : lamports(buyer.lamports, 'Buyer balance');
  const lifetime = await connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: snapshotSlot });
  requireThat(safeInteger(lifetime.context?.slot, 'Blockhash context slot', 1) >= snapshotSlot, 'STALE_RPC_STATE', 'Blockhash context predates verification.');
  const built = buildSettlementTransaction({ ...terms, ...lifetime.value });
  const [fee, rent] = await Promise.all([
    connection.getFeeForMessage(built.transaction.compileMessage(), 'finalized'),
    connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'finalized'),
  ]);
  requireThat(safeInteger(fee.context?.slot, 'Fee context slot', 1) >= lifetime.context.slot, 'STALE_RPC_STATE', 'Fee estimate predates its blockhash.');
  const networkFee = BigInt(safeInteger(fee.value, 'Network fee', 1));
  const accountRent = BigInt(safeInteger(rent, 'ATA rent exemption', 1));
  const rentRequired = destinationExists ? 0n : accountRent;
  const total = BigInt(terms.priceLamports) + networkFee + rentRequired;
  return { schemaVersion: 1, kind: 'mainnet-sale-preflight', verified: true, observedAt: iso(), cluster: 'mainnet-beta', genesisHash,
    commitment: 'finalized', networkWrites: 0, transactionsSent: 0, terms, feeKey,
    costs: { priceLamports: terms.priceLamports, networkFeeLamports: networkFee.toString(), buyerAtaExists: destinationExists,
      buyerAtaRentLamports: rentRequired.toString(), totalEstimatedBuyerDebitLamports: total.toString(),
      buyerBalanceLamports: buyerBalance.toString(), additionalLamportsNeeded: (total > buyerBalance ? total - buyerBalance : 0n).toString() },
    readyToSettle: buyerBalance >= total, snapshotSlot, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight,
    messageSha256: built.messageSha256,
    statement: 'Read-only mainnet eligibility and fee estimate. No transaction was signed or submitted. State and costs can change before settlement; this does not reserve the asset or guarantee execution.' };
}

function tokenBalance(entries, index, terms, holder, amount, label, allowMissing = false) {
  const found = entries.filter(entry => entry.accountIndex === index);
  if (allowMissing && found.length === 0) return null;
  requireThat(found.length === 1, 'TOKEN_BALANCE_MISMATCH', `${label} token balance is missing or duplicated.`);
  const entry = found[0];
  requireThat(entry.mint === terms.mint && entry.owner === holder && entry.programId === TOKEN_PROGRAM_ID.toBase58()
    && entry.uiTokenAmount?.decimals === 0 && entry.uiTokenAmount.amount === amount,
  'TOKEN_BALANCE_MISMATCH', `${label} must report the exact Fee Key mint, owner and integer amount.`);
  return entry;
}

function comparePreflight(preflight, terms, current, transactionSlot) {
  if (!preflight) return null;
  requireThat(preflight.kind === 'mainnet-sale-preflight' && preflight.verified === true && preflight.cluster === 'mainnet-beta'
    && preflight.genesisHash === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
    && termFields.every(field => preflight.terms?.[field] === terms[field]), 'PREFLIGHT_MISMATCH', 'Supplied preflight does not match these mainnet sale terms.');
  const before = checkedFeeKey(preflight.feeKey, terms, terms.seller, terms.sourceTokenAccount);
  const snapshotSlot = safeInteger(preflight.snapshotSlot, 'Preflight snapshot slot', 1);
  requireThat(before.slot <= snapshotSlot && before.slot < transactionSlot && snapshotSlot < transactionSlot,
    'PREFLIGHT_MISMATCH', 'Supplied preflight must record finalized account state from before this transaction slot.');
  const linkage = ['lockAccount', 'poolId', 'lpMint', 'mintA', 'mintB', 'mintProgramA', 'mintProgramB', 'originalLockOwner'];
  requireThat(linkage.every(field => typeof before[field] === 'string' && before[field] === current[field]),
    'LOCK_LINKAGE_CHANGED', 'Raydium lock or pool linkage differs from the supplied preflight.');
  return { suppliedRecordMatched: true, lockAndPoolLinkageUnchanged: true,
    preflightSlot: before.slot, currentSlot: current.slot,
    lockedLpAmountBefore: before.lockedLpAmount, lockedLpAmountNow: current.lockedLpAmount,
    note: 'The supplied JSON is a local record, not an independent attestation. Fee collection can legitimately change lock accounting between reads.' };
}

/** Independently inspect the exact finalized exchange; never infer commercial adoption. */
export async function verifyMainnetSale({ connection, terms: input, signature, preflight, expectedMessageSha256, sonaReceipt }) {
  const terms = normalizeSaleTerms(input);
  try { requireThat(typeof signature === 'string' && bs58.decode(signature).length === 64, 'INVALID_SIGNATURE', 'Provide a public 64-byte transaction signature.'); }
  catch { fail('INVALID_SIGNATURE', 'Provide a public 64-byte transaction signature.'); }
  const genesisHash = await verifyNetwork(connection, 'mainnet-beta');
  const [statuses, result] = await Promise.all([
    connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
    connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
  ]);
  const status = statuses?.value?.[0];
  requireThat(status?.confirmationStatus === 'finalized' && status.err === null && result?.meta?.err === null,
    'NOT_FINALIZED_SUCCESS', 'The transaction is missing, failed or not finalized.');
  const slot = safeInteger(result.slot, 'Transaction slot', 1);
  requireThat(safeInteger(status.slot, 'Signature status slot', 1) === slot && safeInteger(statuses.context?.slot, 'Status context slot', 1) >= slot,
    'RPC_SLOT_MISMATCH', 'Transaction and signature-status slots disagree.');
  const blockTime = safeInteger(result.blockTime, 'Transaction block time', 1);
  requireThat((result.version === undefined || result.version === 'legacy') && Array.isArray(result.transaction?.message?.accountKeys)
    && result.transaction.signatures?.length === 2 && result.transaction.signatures[0] === signature,
  'UNSUPPORTED_TRANSACTION', 'Expected the canonical legacy two-signer exchange.');
  const message = result.transaction.message;
  const built = buildSettlementTransaction({ ...terms, blockhash: message.recentBlockhash, lastValidBlockHeight: 1 });
  let transaction;
  try {
    transaction = Transaction.populate(message, result.transaction.signatures);
    verifyCanonicalSignedTransaction({ transactionBase64: transaction.serialize().toString('base64'),
      expectedTransactionBase64: built.transactionBase64, requiredSigners: [terms.buyer, terms.seller] });
  } catch { fail('CANONICAL_TRANSACTION_MISMATCH', 'The transaction or signatures do not match the exact agreed exchange.'); }
  const messageSha256 = digest(transaction.serializeMessage());
  if (expectedMessageSha256 !== undefined) requireThat(typeof expectedMessageSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedMessageSha256)
    && expectedMessageSha256 === messageSha256, 'MESSAGE_HASH_MISMATCH', 'Transaction message differs from the expected hash.');
  const keys = message.accountKeys.map(String), meta = result.meta;
  requireThat(Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances) && meta.preBalances.length === keys.length
    && meta.postBalances.length === keys.length, 'MISSING_RPC_DATA', 'Complete pre/post SOL balances are required.');
  const before = meta.preBalances.map((value, i) => lamports(value, `Pre-balance ${i}`));
  const after = meta.postBalances.map((value, i) => lamports(value, `Post-balance ${i}`));
  const fee = BigInt(safeInteger(meta.fee, 'Actual network fee', 1));
  const sellerIndex = keys.indexOf(terms.seller), buyerIndex = keys.indexOf(terms.buyer);
  const sourceIndex = keys.indexOf(terms.sourceTokenAccount), targetIndex = keys.indexOf(terms.destinationTokenAccount);
  requireThat([sellerIndex, buyerIndex, sourceIndex, targetIndex].every(index => index >= 0), 'MISSING_RPC_DATA', 'Expected transaction accounts are missing.');
  const price = BigInt(terms.priceLamports), rent = after[targetIndex] - before[targetIndex];
  requireThat(rent >= 0n && after[sellerIndex] - before[sellerIndex] === price
    && before[buyerIndex] - after[buyerIndex] === price + fee + rent,
  'SOL_BALANCE_MISMATCH', 'SOL balances do not show the exact agreed payment plus buyer fee and ATA funding.');
  for (let i = 0; i < keys.length; i++) if (![sellerIndex, buyerIndex, targetIndex].includes(i)) {
    requireThat(before[i] === after[i], 'SOL_BALANCE_MISMATCH', 'An unrelated account SOL balance changed.');
  }
  requireThat(Array.isArray(meta.preTokenBalances) && Array.isArray(meta.postTokenBalances), 'MISSING_RPC_DATA', 'Complete NFT pre/post token balances are required.');
  for (const entry of [...meta.preTokenBalances, ...meta.postTokenBalances]) {
    requireThat([sourceIndex, targetIndex].includes(safeInteger(entry.accountIndex, 'Token account index')),
      'TOKEN_BALANCE_MISMATCH', 'Unexpected token account in the exchange metadata.');
  }
  tokenBalance(meta.preTokenBalances, sourceIndex, terms, terms.seller, '1', 'Seller before');
  tokenBalance(meta.postTokenBalances, sourceIndex, terms, terms.seller, '0', 'Seller after');
  const priorTarget = tokenBalance(meta.preTokenBalances, targetIndex, terms, terms.buyer, '0', 'Buyer before', true);
  tokenBalance(meta.postTokenBalances, targetIndex, terms, terms.buyer, '1', 'Buyer after');
  requireThat(priorTarget ? rent === 0n : before[targetIndex] === 0n && rent > 0n,
    'ATA_FUNDING_MISMATCH', 'ATA funding does not match supported empty-existing or newly-created account behavior.');
  const currentFeeKey = checkedFeeKey(await verifyFeeKey({ connection, cluster: 'mainnet-beta', commitment: 'finalized',
    minContextSlot: slot, mint: terms.mint, owner: terms.buyer, tokenAccount: terms.destinationTokenAccount }), terms, terms.buyer, terms.destinationTokenAccount, slot);
  const preflightComparison = comparePreflight(preflight, terms, currentFeeKey, slot);
  let receiptComparison = null;
  if (sonaReceipt !== undefined) {
    requireThat(sonaReceipt && sonaReceipt.cluster === 'mainnet-beta' && sonaReceipt.commitment === 'finalized'
      && sonaReceipt.signature === signature && sonaReceipt.messageSha256 === messageSha256 && sonaReceipt.slot === slot
      && ['mint', 'buyer', 'seller', 'priceLamports'].every(field => sonaReceipt[field] === terms[field]),
    'SONA_RECEIPT_MISMATCH', 'The supplied Sona receipt does not match the finalized transaction.');
    receiptComparison = { suppliedReceiptMatched: true, note: 'A supplied receipt is not independently authenticated by this module. The CLI can fetch and identify the public Sona endpoint explicitly.' };
  }
  return { schemaVersion: 1, kind: 'mainnet-canonical-exchange-verification', verified: true, observedAt: iso(),
    cluster: 'mainnet-beta', genesisHash, commitment: 'finalized', networkWrites: 0, transactionsSent: 0,
    signature, slot, blockTime, terms, messageSha256, bothSignaturesVerified: true, canonicalInstructionsVerified: true,
    tokenTransfer: { mint: terms.mint, amount: '1', decimals: 0, source: terms.sourceTokenAccount, destination: terms.destinationTokenAccount,
      sellerBefore: '1', sellerAfter: '0', buyerBefore: '0', buyerAfter: '1' },
    payment: { sellerReceivedLamports: price.toString(), networkFeeLamports: fee.toString(), buyerAtaFundingLamports: rent.toString(),
      buyerTotalDebitLamports: (price + fee + rent).toString() }, currentFeeKey, preflightComparison, receiptComparison,
    historicalRaydiumEligibility: preflightComparison
      ? 'Supported by the supplied earlier finalized preflight observation and matching current lock/pool linkage. The local JSON is not an independent or tamper-proof attestation.'
      : 'Not established at the historical transaction slot. Current Raydium eligibility alone does not prove before-sale lock state; a preflight must be recorded before the exchange.',
    sonaAttribution: 'Not established by canonical transaction shape alone.',
    statement: 'Verified a finalized canonical one-NFT-for-SOL exchange and current buyer ownership of a genuine Raydium Fee Key. Historical Raydium eligibility is scoped separately. This cannot establish independent commercial counterparties, market adoption, valuation, or whether the participants share control.' };
}
