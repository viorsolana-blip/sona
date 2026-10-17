/**
 * Bilateral, non-custodial Fee Key sale. This module never handles private keys.
 * The seller approves each buyer; a listing is not an escrow or an open order.
 * One canonical transaction creates the buyer ATA, transfers exactly one NFT,
 * and pays the seller. Solana rolls back the instruction effects on failure.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from '@solana/spl-token';

const U64_MAX = (1n << 64n) - 1n;

export class SettlementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettlementError';
    this.code = code;
  }
}

function fail(code, message) { throw new SettlementError(code, message); }

function publicKey(value, field) {
  try { return value instanceof PublicKey ? value : new PublicKey(value); }
  catch { fail('INVALID_ADDRESS', `${field} must be a Solana public key.`); }
}

function walletKey(value, field) {
  const key = publicKey(value, field);
  if (!PublicKey.isOnCurve(key.toBytes())) fail('INVALID_WALLET', `${field} must be a signing wallet.`);
  return key;
}

/** Integers only: no floating point conversions anywhere in the payment path. */
export function parseLamports(value) {
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) {
    fail('INVALID_PRICE', 'Price must be a positive integer lamport string.');
  }
  const amount = BigInt(value);
  if (amount <= 0n || amount > U64_MAX) fail('INVALID_PRICE', 'Price is outside the unsigned 64-bit lamport range.');
  return amount;
}

export function solToLamports(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(value)) {
    fail('INVALID_PRICE', 'SOL price must be a decimal string with at most nine decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  return parseLamports(BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))).toString();
}

/**
 * Re-read chain ownership at prepare/submit time. This proves an NFT is owned,
 * not that it is a Raydium Fee Key: callers must also run the Raydium verifier.
 */
export async function inspectSettlementAsset({ connection, seller, mint, sourceTokenAccount }) {
  const sellerKey = walletKey(seller, 'Seller');
  const mintKey = publicKey(mint, 'Mint');
  const sourceKey = publicKey(sourceTokenAccount, 'Source token account');
  const [mintState, tokenState] = await Promise.all([
    getMint(connection, mintKey, 'confirmed', TOKEN_PROGRAM_ID),
    getAccount(connection, sourceKey, 'confirmed', TOKEN_PROGRAM_ID),
  ]);
  if (!mintState.isInitialized || mintState.decimals !== 0 || mintState.supply !== 1n) {
    fail('NOT_UNIQUE_NFT', 'Fee Key must be an initialized, zero-decimal mint with supply one.');
  }
  if (mintState.mintAuthority || mintState.freezeAuthority) {
    fail('MUTABLE_NFT', 'Fee Key mint and freeze authorities must be revoked.');
  }
  if (!tokenState.isInitialized || tokenState.isFrozen || !tokenState.owner.equals(sellerKey)
    || !tokenState.mint.equals(mintKey) || tokenState.amount !== 1n) {
    fail('NOT_OWNED', 'Seller no longer owns one transferable token in the listed account.');
  }
  return { seller: sellerKey.toBase58(), mint: mintKey.toBase58(), sourceTokenAccount: sourceKey.toBase58(),
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(), amount: '1', decimals: 0 };
}

/**
 * Low-level deterministic builder. It does not authenticate listings/assets.
 * The service must call prepareSettlement with a trusted Raydium verifier.
 * Buyer is always fee payer + NFT recipient; seller is always SOL recipient.
 */
export function buildSettlementTransaction({ seller, buyer, mint, sourceTokenAccount, priceLamports,
  blockhash, lastValidBlockHeight }) {
  const sellerKey = walletKey(seller, 'Seller');
  const buyerKey = walletKey(buyer, 'Buyer');
  const mintKey = publicKey(mint, 'Mint');
  const sourceKey = publicKey(sourceTokenAccount, 'Source token account');
  if (sellerKey.equals(buyerKey)) fail('SELF_TRADE', 'Buyer and seller must be different wallets.');
  const price = parseLamports(priceLamports);
  const hash = publicKey(blockhash, 'Recent blockhash').toBase58();
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) {
    fail('INVALID_EXPIRY', 'A valid lastValidBlockHeight is required.');
  }
  const destination = getAssociatedTokenAddressSync(mintKey, buyerKey, false, TOKEN_PROGRAM_ID);
  if (sourceKey.equals(destination)) fail('INVALID_SOURCE', 'Seller source cannot be the buyer destination.');
  const transaction = new Transaction({ feePayer: buyerKey, blockhash: hash, lastValidBlockHeight });
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(buyerKey, destination, buyerKey, mintKey, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(sourceKey, mintKey, destination, sellerKey, 1n, 0, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: buyerKey, toPubkey: sellerKey, lamports: price }),
  );
  const message = transaction.serializeMessage();
  return {
    transaction,
    transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
    messageBase64: message.toString('base64'),
    messageSha256: createHash('sha256').update(message).digest('hex'),
    seller: sellerKey.toBase58(), buyer: buyerKey.toBase58(), mint: mintKey.toBase58(),
    sourceTokenAccount: sourceKey.toBase58(), destinationTokenAccount: destination.toBase58(),
    priceLamports: price.toString(), blockhash: hash, lastValidBlockHeight,
    requiredSigners: [buyerKey.toBase58(), sellerKey.toBase58()],
  };
}

export async function prepareSettlement({ connection, listing, buyer, verifyFeeKey }) {
  if (typeof verifyFeeKey !== 'function') fail('VERIFIER_REQUIRED', 'Raydium Fee Key verification is required.');
  const { seller, mint, sourceTokenAccount, priceLamports } = listing;
  const feeKey = await verifyFeeKey({ connection, seller, owner: seller, mint, sourceTokenAccount,
    tokenAccount: sourceTokenAccount, cluster: listing.cluster, listing });
  if (!feeKey || feeKey.verified !== true) fail('UNVERIFIED_FEE_KEY', 'Raydium Fee Key verification failed.');
  // The injected verifier is a trusted service dependency, never client input.
  if (feeKey.mint && !publicKey(feeKey.mint, 'Verified mint').equals(publicKey(mint, 'Mint'))) {
    fail('UNVERIFIED_FEE_KEY', 'Verifier returned a different mint.');
  }
  await inspectSettlementAsset({ connection, seller, mint, sourceTokenAccount });
  const lifetime = await connection.getLatestBlockhash('confirmed');
  return { ...buildSettlementTransaction({ seller, buyer, mint, sourceTokenAccount, priceLamports, ...lifetime }), feeKey };
}

function decodeTransaction(value) {
  if (typeof value !== 'string' || value.length > 2200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail('INVALID_TRANSACTION', 'Expected a base64 legacy Solana transaction.');
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > 1232 || bytes.toString('base64') !== value) throw new Error('Non-canonical encoding');
    return Transaction.from(bytes);
  } catch { fail('INVALID_TRANSACTION', 'Transaction bytes could not be decoded.'); }
}

/**
 * Compare exact signed message bytes to the server-stored canonical request.
 * Never rebuild using parameters supplied alongside the signed transaction.
 * This binds price, recipient, mint, programs, fee payer and recent blockhash.
 */
export function verifyCanonicalSignedTransaction({ transactionBase64, expectedTransactionBase64, requiredSigners = [] }) {
  const transaction = decodeTransaction(transactionBase64);
  const expected = decodeTransaction(expectedTransactionBase64);
  const actualMessage = transaction.serializeMessage();
  const expectedMessage = expected.serializeMessage();
  if (actualMessage.length !== expectedMessage.length || !timingSafeEqual(actualMessage, expectedMessage)) {
    fail('TRANSACTION_CHANGED', 'Wallet returned a changed transaction. Price, recipient and instructions must match exactly.');
  }
  if (!transaction.verifySignatures(false)) fail('INVALID_SIGNATURE', 'A transaction signature is invalid.');
  for (const signer of requiredSigners) {
    const key = publicKey(signer, 'Required signer');
    if (!transaction.signatures.some((entry) => entry.publicKey.equals(key) && entry.signature)) {
      fail('MISSING_SIGNATURE', `Missing required signature: ${key.toBase58()}`);
    }
  }
  return { transaction, transactionBase64: transaction.serialize({ requireAllSignatures: false, verifySignatures: true }).toString('base64'),
    messageSha256: createHash('sha256').update(actualMessage).digest('hex'),
    signedBy: transaction.signatures.filter((entry) => entry.signature).map((entry) => entry.publicKey.toBase58()) };
}

export async function assertSettlementNotExpired({ connection, lastValidBlockHeight }) {
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) fail('INVALID_EXPIRY', 'Invalid settlement expiry.');
  const currentBlockHeight = await connection.getBlockHeight('confirmed');
  if (currentBlockHeight > lastValidBlockHeight) fail('SETTLEMENT_EXPIRED', 'Approval expired. Create a new request for both wallets to sign.');
  return currentBlockHeight;
}

/**
 * Recover a buyer's direct broadcast of a seller-approved transaction. Searches
 * a bounded page; null means "no exact finalized match found", NEVER proof that
 * the transaction did not land. Callers must re-check current NFT ownership
 * before making an expired listing available again. RPC failures propagate.
 */
export async function findExternalSettlement({ connection, settlement, limit = 100, notBeforeBlockTime }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_SCAN_LIMIT', 'Receipt scan limit must be between 1 and 100.');
  const expected = decodeTransaction(settlement.transactionBase64);
  const expectedMessage = expected.serializeMessage();
  const expectedHash = createHash('sha256').update(expectedMessage).digest('hex');
  if (settlement.messageSha256 && settlement.messageSha256 !== expectedHash) {
    fail('INVALID_CANONICAL_MESSAGE', 'Stored settlement message hash does not match its transaction.');
  }
  const source = publicKey(settlement.sourceTokenAccount, 'Source token account');
  const entries = await connection.getSignaturesForAddress(source, { limit }, 'finalized');
  for (const entry of entries) {
    if (entry.err || (Number.isFinite(notBeforeBlockTime) && entry.blockTime !== null && entry.blockTime < notBeforeBlockTime)) continue;
    const result = await connection.getTransaction(entry.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    if (!result || result.meta?.err !== null || result.transaction.signatures?.[0] !== entry.signature) continue;
    const message = result.transaction.message;
    if (!message?.serialize) continue;
    const actualMessage = Buffer.from(message.serialize());
    if (actualMessage.length !== expectedMessage.length || !timingSafeEqual(actualMessage, expectedMessage)) continue;
    // populate + signature verification prevents a malformed RPC response from
    // becoming a receipt merely because it copied the canonical message bytes.
    try {
      const transaction = Transaction.populate(message, result.transaction.signatures);
      verifyCanonicalSignedTransaction({ transactionBase64: transaction.serialize().toString('base64'),
        expectedTransactionBase64: settlement.transactionBase64, requiredSigners: [settlement.buyer, settlement.seller] });
    } catch { continue; }
    return { signature: entry.signature, slot: result.slot, commitment: 'finalized', messageSha256: expectedHash };
  }
  return null;
}

export async function submitSettlement({ connection, settlement, transactionBase64 }) {
  await assertSettlementNotExpired({ connection, lastValidBlockHeight: settlement.lastValidBlockHeight });
  const { transaction } = verifyCanonicalSignedTransaction({ transactionBase64,
    expectedTransactionBase64: settlement.transactionBase64,
    requiredSigners: [settlement.buyer, settlement.seller] });
  await inspectSettlementAsset({ connection, seller: settlement.seller, mint: settlement.mint,
    sourceTokenAccount: settlement.sourceTokenAccount });
  const signature = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash: settlement.blockhash,
    lastValidBlockHeight: settlement.lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) {
    const error = new SettlementError('SETTLEMENT_FAILED', `Settlement failed: ${JSON.stringify(confirmation.value.err)}`);
    error.signature = signature;
    throw error;
  }
  return { signature, confirmationSlot: confirmation.context.slot, commitment: 'confirmed' };
}
