import { randomBytes, randomUUID, createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import { prepareSettlement, verifyCanonicalSignedTransaction, inspectSettlementAsset, assertSettlementNotExpired, parseLamports, findExternalSettlement } from '../chain/settlement.mjs';

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}
const problem = (status, code, message) => { throw new ApiError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const iso = ms => new Date(ms).toISOString();
const short = value => `${value.slice(0, 4)}…${value.slice(-4)}`;
const finalStates = new Set(['confirmed', 'expired', 'canceled', 'failed']);
const MINTS = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD9KZCtNH6nYxn3S9ieYZz: 'USDT',
};
export function address(value) {
  try { const key = new PublicKey(value); if (!PublicKey.isOnCurve(key.toBytes())) throw Error(); return key.toBase58(); }
  catch { problem(400, 'INVALID_WALLET', 'Enter a valid signing wallet address.'); }
}
function price(value) {
  const result = parseLamports(value);
  if (result > 1_000_000_000_000_000n) problem(400, 'INVALID_PRICE', 'The maximum listing price is 1,000,000 SOL.');
  return result.toString();
}
function listingFrom(tx, id) { const value = tx.get('listing', id); if (!value) problem(404, 'NOT_FOUND', 'Listing not found.'); return value; }
function tradeFrom(tx, id, owner) {
  const value = tx.get('trade', id); if (!value) problem(404, 'NOT_FOUND', 'Purchase not found.');
  if (owner && owner !== value.seller && owner !== value.buyer) problem(403, 'NOT_PARTICIPANT', 'This purchase belongs to different wallets.');
  return value;
}
const sameState = (a, b) => a && b && a.status === b.status && a.version === b.version && a.signature === b.signature;

/** Shared chain validation and canonical transactions, with durable D1 coordination. */
export class HostedMarketplace {
  constructor({ store, connection, cluster = 'mainnet-beta', genesisHash, origin, verifyFeeKey, discoverFeeKeys, now = Date.now,
    settlement = {} }) {
    Object.assign(this, { store, connection, cluster, genesisHash, origin, verifyFeeKey, discoverFeeKeys, now });
    // Dependency injection is internal to tests, never accepted from API input.
    this.settlement = { prepareSettlement, verifyCanonicalSignedTransaction, inspectSettlementAsset, assertSettlementNotExpired, findExternalSettlement, ...settlement };
  }
  static async create(options) { const market = new HostedMarketplace(options); await market.initialize(); return market; }
  async initialize() {
    const existing = await this.store.get('metadata', 'network');
    if (existing) {
      if (existing.cluster !== this.cluster || existing.genesisHash !== this.genesisHash) throw new Error('This database belongs to another Solana network.');
      return;
    }
    await this.store.initialize();
    await this.store.transaction(tx => {
      const network = tx.get('metadata', 'network');
      if (network && (network.cluster !== this.cluster || network.genesisHash !== this.genesisHash)) throw new Error('This database belongs to another Solana network.');
      if (!network) tx.put('metadata', { id: 'network', cluster: this.cluster, genesisHash: this.genesisHash });
    });
  }
  async challenge(value) {
    const owner = address(value), id = randomUUID(), issued = this.now(), expires = issued + 300_000;
    const message = `Sona wallet authentication\nOrigin: ${this.origin}\nNetwork: ${this.cluster}\nWallet: ${owner}\nNonce: ${randomBytes(24).toString('hex')}\nIssued at: ${iso(issued)}\nExpires at: ${iso(expires)}\n\nAuthenticate this wallet with Sona. This message does not authorize an asset transfer.`;
    await this.store.createChallenge({ id, address: owner, message, expires }, issued);
    return { challengeId: id, message };
  }
  async authenticate({ address: owner, challengeId, signatureBase64 }) {
    address(owner);
    const challenge = await this.store.challenge(typeof challengeId === 'string' ? challengeId : '');
    if (!challenge || challenge.address !== owner || challenge.expires <= this.now()
      || !challenge.message.startsWith(`Sona wallet authentication\nOrigin: ${this.origin}\nNetwork: ${this.cluster}\nWallet: ${owner}\n`)) problem(401, 'CHALLENGE_EXPIRED', 'Request a fresh wallet authentication message.');
    const bytes = Buffer.from(typeof signatureBase64 === 'string' ? signatureBase64 : '', 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signatureBase64 || !nacl.sign.detached.verify(Buffer.from(challenge.message), bytes, new PublicKey(owner).toBytes())) problem(401, 'INVALID_SIGNATURE', 'Wallet authentication signature is invalid.');
    const token = randomBytes(32).toString('base64url'), expires = this.now() + 3_600_000;
    const consumed = await this.store.consumeChallenge({ id: challenge.id, address: owner, message: challenge.message, now: this.now(), hash: digest(token), expires });
    if (!consumed) problem(401, 'REPLAY', 'This authentication message was already used or expired.');
    return { token, address: owner, expiresAt: iso(expires) };
  }
  async session(token) {
    if (typeof token !== 'string' || token.length > 128) return null;
    return (await this.store.session(digest(token), this.now()))?.address || null;
  }
  async logout(token) { if (typeof token === 'string' && token.length <= 128) await this.store.logout(digest(token)); }
  activity(tx, owner, type, text, extra = {}) {
    tx.put('activity', { id: randomUUID(), owner, type, text, title: text, time: iso(this.now()), createdAt: iso(this.now()), ...extra });
    // Keep the interface's recent activity feed bounded. Trade records and
    // finalized receipts are not pruned by this display-only retention policy.
    const old = tx.all('activity').filter(a => a.owner === owner).reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const entry of old.slice(100, 105)) tx.remove('activity', entry.id);
    const recent = tx.all('activity').reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = Math.min(400, Math.floor(this.store.maxRecords / 3));
    for (const entry of recent.slice(limit, limit + 5)) tx.remove('activity', entry.id);
  }
  pruneUnsigned(tx) {
    // Unsigned terminal requests do not constitute settlement evidence. Bound
    // this history so an unfunded request/cancel loop cannot fill durable state.
    for (const t of tx.all('trade').filter(t => t.status === 'requested' && Date.parse(t.expiresAt) <= this.now()).slice(0, 10)) tx.remove('trade', t.id);
    const terminal = tx.all('trade').filter(t => finalStates.has(t.status) && !t.approvedTransaction && !t.submittedTransaction && !t.signature)
      .reverse().sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const limit = Math.min(100, Math.floor(this.store.maxRecords / 10));
    for (const t of terminal.slice(limit, limit + 10)) tx.remove('trade', t.id);
  }
  reserveCapacity(tx, additionalRecords, additionalPending = 0) {
    this.pruneUnsigned(tx);
    const pending = tx.all('trade').filter(t => !finalStates.has(t.status) && (t.status !== 'requested' || Date.parse(t.expiresAt) > this.now())).length + additionalPending;
    // A completed trade can add two activity entries and one immutable receipt.
    // Protect that headroom before accepting any new listing or request.
    if (pending > Math.min(200, Math.floor(this.store.maxRecords / 10))
      || tx.count() + additionalRecords + 3 * pending + 8 > this.store.maxRecords) problem(503, 'MARKETPLACE_CAPACITY', 'New listings and requests are temporarily at capacity. Existing settlements remain available.');
  }
  viewPosition(p) {
    const mint = p.mint || p.feeKeyMint;
    return { ...p, id: mint, mint, feeKeyMint: mint, sourceTokenAccount: p.tokenAccount, base: MINTS[p.mintA] || short(p.mintA || mint), quote: MINTS[p.mintB] || short(p.mintB || mint), protocol: 'Raydium', type: 'Fee rights', lock: 'Permanent', duration: 'Permanent', annualFees: null, fees: null, claimable: null, value: null, verifiedSlot: p.slot };
  }
  viewTrade(t, owner) {
    if (owner && owner !== t.seller && owner !== t.buyer) problem(403, 'NOT_PARTICIPANT', 'This purchase belongs to different wallets.');
    const { settlement, approvedTransaction, submittedTransaction, preparationId, ...safe } = t;
    return safe;
  }
  async getListing(id) { const result = await this.store.get('listing', id); if (!result) problem(404, 'NOT_FOUND', 'Listing not found.'); return result; }
  async getTrade(id, owner) {
    const result = await this.store.get('trade', id); if (!result) problem(404, 'NOT_FOUND', 'Purchase not found.');
    if (owner !== result.seller && owner !== result.buyer) problem(403, 'NOT_PARTICIPANT', 'This purchase belongs to different wallets.');
    return result;
  }
  assertActive(l) { if (l.status !== 'active' || Date.parse(l.expiresAt) <= this.now()) problem(409, 'LISTING_UNAVAILABLE', 'This listing is no longer available.'); }
  transition(tx, t, status, extra = {}) { return tx.put('trade', { ...t, ...extra, status, version: (t.version || 0) + 1, updatedAt: iso(this.now()) }); }
  release(tx, trade, unavailable = false) {
    const listing = tx.get('listing', trade.listingId);
    if (listing?.status === 'reserved' && listing.reservedBy === trade.id) {
      listing.status = unavailable ? 'unavailable' : Date.parse(listing.expiresAt) > this.now() ? 'active' : 'expired';
      delete listing.reservedBy; tx.put('listing', listing);
    }
  }
  async finishPending(snapshot, status, { error, unavailable = false } = {}) {
    return this.store.transaction(tx => {
      const fresh = tx.get('trade', snapshot.id);
      if (!sameState(fresh, snapshot) || finalStates.has(fresh.status)) return false;
      this.transition(tx, fresh, status, error ? { error } : {}); this.release(tx, fresh, unavailable); this.pruneUnsigned(tx); return true;
    });
  }
  async complete(snapshot, slot, signature = snapshot.signature) {
    if (!signature || !Number.isSafeInteger(slot)) problem(502, 'INVALID_RECEIPT', 'A finalized transaction signature and slot are required.');
    return this.store.transaction(tx => {
      const fresh = tx.get('trade', snapshot.id);
      if (fresh?.status === 'confirmed') return false;
      if (!sameState(fresh, snapshot) || !['approved', 'submitted'].includes(fresh.status)) return false;
      const l = listingFrom(tx, fresh.listingId);
      if (l.status !== 'reserved' || l.reservedBy !== fresh.id) problem(409, 'RESERVATION_CHANGED', 'The purchase reservation changed.');
      const completedAt = iso(this.now());
      const t = this.transition(tx, fresh, 'confirmed', { signature, confirmationSlot: slot, commitment: 'finalized', completedAt });
      l.status = 'sold'; l.signature = signature; delete l.reservedBy; tx.put('listing', l);
      for (const other of tx.all('trade')) if (other.listingId === l.id && other.id !== t.id && !finalStates.has(other.status)) this.transition(tx, other, 'canceled');
      this.activity(tx, t.buyer, 'purchase', 'Fee Key received', { tradeId: t.id, signature });
      this.activity(tx, t.seller, 'sale', 'Fee Key sold', { tradeId: t.id, signature });
      tx.put('receipt', { id: signature, cluster: this.cluster, signature, slot, commitment: 'finalized', mint: t.mint, buyer: t.buyer, seller: t.seller, priceLamports: t.priceLamports, messageSha256: t.settlement.messageSha256, createdAt: completedAt });
      return true;
    });
  }
  async reconcile({ tradeId, limit = 1 } = {}) {
    // Request-driven reconciliation survives isolate restarts. A targeted trade
    // read always checks its own receipt, even during a busy marketplace.
    if (!await this.store.rateLimit(`reconcile:${tradeId || 'marketplace'}`, this.now(), 1, tradeId ? 1000 : 15000)) return;
    const values = tradeId ? [await this.store.get('trade', tradeId)].filter(Boolean) : await this.store.all('trade');
    const pending = values.filter(t => !finalStates.has(t.status) && (t.settlement || t.status === 'preparing'))
      .sort((a, b) => (a.checkedAt || a.createdAt).localeCompare(b.checkedAt || b.createdAt)).slice(0, limit);
    if (!pending.length) return;
    let height;
    for (const t of pending) {
      if (t.status === 'preparing') {
        if (Date.parse(t.preparingLeaseUntil) <= this.now()) await this.finishPending(t, 'failed', { error: 'Preparation expired. Request the purchase again.' });
        continue;
      }
      height ??= await this.connection.getBlockHeight('finalized');
      if (t.signature) {
        const status = (await this.connection.getSignatureStatuses([t.signature], { searchTransactionHistory: true })).value[0];
        if (status?.confirmationStatus === 'finalized') {
          if (status.err) await this.finishPending(t, 'failed', { error: 'The transaction failed on Solana.' });
          else await this.complete(t, status.slot);
          continue;
        }
        if (status) { await this.markChecked(t); continue; }
      }
      if (height > t.settlement.lastValidBlockHeight) {
        if (t.status === 'approved') {
          const external = await this.settlement.findExternalSettlement({ connection: this.connection, settlement: t.settlement, limit: 10, notBeforeBlockTime: Math.floor(Date.parse(t.createdAt) / 1000) - 60 });
          if (external) { await this.complete(t, external.slot, external.signature); continue; }
        }
        let stillOwned = true;
        try { await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: t.mint, owner: t.seller, tokenAccount: t.settlement.sourceTokenAccount, commitment: 'finalized' }); }
        catch (error) {
          if (error.name !== 'RaydiumEligibilityError' && error.name !== 'SettlementError') throw error;
          stillOwned = false;
        }
        await this.finishPending(t, 'expired', { unavailable: !stillOwned });
      } else await this.markChecked(t);
    }
  }
  async markChecked(snapshot) {
    await this.store.transaction(tx => {
      const fresh = tx.get('trade', snapshot.id);
      if (sameState(fresh, snapshot)) tx.put('trade', { ...fresh, checkedAt: iso(this.now()) });
    });
  }
  async listings({ offset = 0 } = {}) {
    await this.reconcile();
    const values = (await this.store.all('listing')).filter(l => l.status === 'reserved' || l.status === 'active' && Date.parse(l.expiresAt) > this.now()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { listings: values.slice(offset, offset + 50), total: values.length, nextOffset: values.length > offset + 50 ? offset + 50 : null };
  }
  async wallet(owner, authenticatedOwner) {
    owner = address(owner);
    const [balance, result, listings, trades, activity] = await Promise.all([
      this.connection.getBalance(new PublicKey(owner), 'confirmed'),
      this.discoverFeeKeys({ connection: this.connection, cluster: this.cluster, owner, maxCandidates: 200, maxVerificationCalls: 8 }),
      this.store.all('listing'), this.store.all('trade'), this.store.all('activity'),
    ]);
    if (!Number.isSafeInteger(balance)) problem(502, 'BALANCE_RANGE', 'RPC balance could not be represented exactly.');
    return { address: owner, balanceLamports: String(balance), positions: result.positions.map(p => this.viewPosition(p)), rejected: result.rejected, slot: result.slot, truncated: result.truncated || false, scannedCandidates: result.scannedCandidates, totalCandidates: result.totalCandidates, verificationCalls: result.verificationCalls, deferredCandidates: result.deferredCandidates,
      listings: listings.filter(l => l.seller === owner),
      trades: authenticatedOwner === owner ? trades.filter(t => t.seller === owner || t.buyer === owner).map(t => this.viewTrade(t, owner)) : [],
      activity: authenticatedOwner === owner ? activity.filter(a => a.owner === owner) : [] };
  }
  async createListing(owner, input) {
    owner = address(owner); const lamports = price(input.priceLamports), days = input.expiresInDays ?? 7;
    if (![1, 7, 30].includes(days)) problem(400, 'INVALID_EXPIRY', 'Choose a 1, 7 or 30 day listing.');
    const p = await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: input.mint, owner });
    if (!p?.verified) problem(400, 'UNVERIFIED_FEE_KEY', 'Only verified Raydium CPMM Fee Keys can be listed.');
    const listing = { ...this.viewPosition(p), id: randomUUID(), seller: owner, priceLamports: lamports, price: Number(lamports) / 1e9, status: 'active', cluster: this.cluster, createdAt: iso(this.now()), expiresAt: iso(this.now() + days * 86400_000), visibility: 'public' };
    await this.store.transaction(tx => {
      this.reserveCapacity(tx, 2);
      const all = tx.all('listing');
      if (all.filter(l => l.seller === owner && ['active', 'reserved'].includes(l.status) && Date.parse(l.expiresAt) > this.now()).length >= 50) problem(409, 'LISTING_LIMIT', 'This wallet already has 50 open listings.');
      for (const old of all.filter(l => l.mint === listing.mint && ['active', 'reserved'].includes(l.status))) {
        if (old.status === 'reserved') problem(409, 'ALREADY_LISTED', 'This Fee Key has a pending approval. Wait for settlement or expiry.');
        if (old.seller === owner && Date.parse(old.expiresAt) > this.now()) problem(409, 'ALREADY_LISTED', 'This Fee Key already has an active listing.');
        old.status = 'expired'; tx.put('listing', old);
      }
      tx.put('listing', listing); this.activity(tx, owner, 'listing', 'Fee Key listed', { listingId: listing.id });
    });
    return { listing };
  }
  async changeListing(owner, id, input, remove = false) {
    const previous = await this.getListing(id);
    if (previous.seller !== owner) problem(403, 'NOT_OWNER', 'Only the seller can change this listing.');
    this.assertActive(previous);
    const lamports = remove ? null : price(input.priceLamports);
    if (!remove) await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: previous.mint, owner, tokenAccount: previous.tokenAccount });
    const listing = await this.store.transaction(tx => {
      const l = listingFrom(tx, id); this.assertActive(l);
      if (l.seller !== owner) problem(403, 'NOT_OWNER', 'Only the seller can change this listing.');
      if (remove) l.status = 'canceled'; else { l.priceLamports = lamports; l.price = Number(lamports) / 1e9; }
      tx.put('listing', l);
      for (const t of tx.all('trade')) if (t.listingId === id && t.status === 'requested') this.transition(tx, t, 'canceled');
      this.activity(tx, owner, remove ? 'cancellation' : 'listing', remove ? 'Listing removed' : 'Listing price updated', { listingId: id });
      return l;
    }); return { listing };
  }
  async requestPurchase(owner, id) {
    owner = address(owner); const l = await this.getListing(id); this.assertActive(l);
    if (l.seller === owner) problem(400, 'SELF_TRADE', 'Choose a Fee Key listed by another wallet.');
    await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: l.mint, owner: l.seller, tokenAccount: l.tokenAccount });
    const trade = await this.store.transaction(tx => {
      const latest = listingFrom(tx, id); this.assertActive(latest);
      if (latest.priceLamports !== l.priceLamports) problem(409, 'PRICE_CHANGED', 'Listing price changed. Review it again.');
      const requests = tx.all('trade').filter(t => t.listingId === id && !finalStates.has(t.status));
      const prior = requests.find(t => t.buyer === owner); if (prior) return prior;
      if (requests.length >= 20) problem(409, 'REQUEST_LIMIT', 'This listing already has 20 pending purchase requests.');
      this.reserveCapacity(tx, 3, 1);
      const t = { id: randomUUID(), listingId: id, buyer: owner, seller: l.seller, mint: l.mint, priceLamports: l.priceLamports, cluster: this.cluster, status: 'requested', version: 1, createdAt: iso(this.now()), expiresAt: l.expiresAt };
      tx.put('trade', t); this.activity(tx, l.seller, 'request', 'Purchase approval requested', { tradeId: t.id }); this.activity(tx, owner, 'request', 'Purchase requested', { tradeId: t.id }); return t;
    }); return { trade: this.viewTrade(trade, owner) };
  }
  async prepare(owner, id) {
    await this.getTrade(id, owner); await this.reconcile({ tradeId: id });
    const preparationId = randomUUID();
    const { trade, listing } = await this.store.transaction(tx => {
      const t = tradeFrom(tx, id, owner); if (t.seller !== owner) problem(403, 'NOT_SELLER', 'Only the seller can prepare this approval.');
      if (t.status !== 'requested') problem(409, 'TRADE_STATE', 'This request is already being processed.');
      const l = listingFrom(tx, t.listingId); this.assertActive(l);
      if (l.priceLamports !== t.priceLamports) problem(409, 'PRICE_CHANGED', 'The listing price changed. Request the purchase again.');
      l.status = 'reserved'; l.reservedBy = t.id; tx.put('listing', l);
      return { trade: this.transition(tx, t, 'preparing', { preparationId, preparingLeaseUntil: iso(this.now() + 60_000) }), listing: l };
    });
    try {
      const result = await this.settlement.prepareSettlement({ connection: this.connection, listing: { ...listing, sourceTokenAccount: listing.tokenAccount }, buyer: trade.buyer, verifyFeeKey: this.verifyFeeKey });
      const { transaction, ...settlement } = result;
      const t = await this.store.transaction(tx => {
        const current = tradeFrom(tx, id, owner);
        if (!sameState(current, trade) || current.preparationId !== preparationId || Date.parse(current.preparingLeaseUntil) <= this.now()) problem(409, 'TRADE_STATE', 'The request changed or expired during preparation.');
        return this.transition(tx, current, 'prepared', { settlement });
      }); return { trade: this.viewTrade(t, owner), settlement };
    } catch (error) { await this.finishPending(trade, 'failed', { error: 'Preparation did not complete. Request again.' }); throw error; }
  }
  async approve(owner, id, transactionBase64) {
    const t = await this.getTrade(id, owner);
    if (t.seller !== owner) problem(403, 'NOT_SELLER', 'Only the seller can approve.');
    if (t.status !== 'prepared') problem(409, 'TRADE_STATE', 'Prepare a fresh purchase approval.');
    await this.settlement.assertSettlementNotExpired({ connection: this.connection, lastValidBlockHeight: t.settlement.lastValidBlockHeight });
    await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: t.mint, owner, tokenAccount: t.settlement.sourceTokenAccount });
    const verified = this.settlement.verifyCanonicalSignedTransaction({ transactionBase64, expectedTransactionBase64: t.settlement.transactionBase64, requiredSigners: [t.seller] });
    const result = await this.store.transaction(tx => {
      const fresh = tradeFrom(tx, id, owner);
      if (!sameState(fresh, t)) problem(409, 'TRADE_STATE', 'Request changed while approving.');
      const l = listingFrom(tx, t.listingId);
      if (l.status !== 'reserved' || l.reservedBy !== t.id) problem(409, 'RESERVATION_CHANGED', 'The purchase reservation changed.');
      const updated = this.transition(tx, fresh, 'approved', { approvedTransaction: verified.transactionBase64 });
      this.activity(tx, t.buyer, 'approval', 'Seller approved your purchase', { tradeId: t.id }); return updated;
    }); return { trade: this.viewTrade(result, owner) };
  }
  async trade(owner, id) {
    await this.getTrade(id, owner); await this.reconcile({ tradeId: id }); const t = await this.getTrade(id, owner);
    const output = { trade: this.viewTrade(t, owner) };
    if (t.settlement) output.settlement = { ...t.settlement, transactionBase64: t.approvedTransaction || t.settlement.transactionBase64 };
    return output;
  }
  async cancel(owner, id) {
    const trade = await this.store.transaction(tx => {
      const t = tradeFrom(tx, id, owner);
      if (!['requested', 'prepared', 'preparing'].includes(t.status)) problem(409, 'APPROVAL_RELEASED', 'A signed approval cannot be revoked here. Wait until its blockhash expires.');
      const canceled = this.transition(tx, t, 'canceled'); this.release(tx, canceled); this.pruneUnsigned(tx); return canceled;
    }); return { trade: this.viewTrade(trade, owner) };
  }
  async submit(owner, id, transactionBase64) {
    let t = await this.getTrade(id, owner);
    if (t.buyer !== owner) problem(403, 'NOT_BUYER', 'Only the buyer can complete the purchase.');
    if (t.status === 'confirmed') return { trade: this.viewTrade(t, owner), signature: t.signature };
    if (!['approved', 'submitted'].includes(t.status)) problem(409, 'TRADE_STATE', 'The seller must approve this purchase first.');
    const checked = this.settlement.verifyCanonicalSignedTransaction({ transactionBase64, expectedTransactionBase64: t.settlement.transactionBase64, requiredSigners: [t.buyer, t.seller] });
    const signature = bs58.encode(checked.transaction.signature);
    if (t.signature && t.signature !== signature) problem(409, 'SIGNATURE_CHANGED', 'A different transaction was already submitted.');
    if (t.status === 'approved') {
      await this.settlement.assertSettlementNotExpired({ connection: this.connection, lastValidBlockHeight: t.settlement.lastValidBlockHeight });
      await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint: t.mint, owner: t.seller, tokenAccount: t.settlement.sourceTokenAccount });
      await this.settlement.inspectSettlementAsset({ connection: this.connection, seller: t.seller, mint: t.mint, sourceTokenAccount: t.settlement.sourceTokenAccount });
      const snapshot = t;
      t = await this.store.transaction(tx => {
        const current = tradeFrom(tx, id, owner);
        if (['submitted', 'confirmed'].includes(current.status) && current.signature === signature) return current;
        if (!sameState(current, snapshot)) problem(409, 'TRADE_STATE', 'Purchase state changed.');
        const l = listingFrom(tx, t.listingId);
        if (l.status !== 'reserved' || l.reservedBy !== t.id) problem(409, 'RESERVATION_CHANGED', 'The purchase reservation changed.');
        // The signature and exact signed bytes are durably committed before send.
        return this.transition(tx, current, 'submitted', { signature, submittedTransaction: checked.transactionBase64 });
      });
    }
    if (t.status === 'confirmed') return { trade: this.viewTrade(t, owner), signature };
    try {
      const existing = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (existing?.confirmationStatus === 'finalized') {
        if (existing.err) await this.finishPending(t, 'failed', { error: 'The transaction failed on Solana.' });
        else await this.complete(t, existing.slot);
      } else if (!existing) {
        // Re-sending these same signed bytes is idempotent on Solana. A restart
        // never rebuilds a second transaction or assumes a timeout was failure.
        const sent = await this.connection.sendRawTransaction(checked.transaction.serialize(), { skipPreflight: false, maxRetries: 2 });
        if (sent !== signature) throw new Error('RPC returned a different transaction signature.');
      }
    } catch { /* Retain the signature and reservation for later HTTP reconciliation. */ }
    const current = await this.getTrade(id, owner);
    if (current.status === 'failed') problem(409, 'SETTLEMENT_FAILED', current.error);
    return { trade: this.viewTrade(current, owner), signature, pending: current.status !== 'confirmed', ...(current.status !== 'confirmed' ? { message: 'Submitted for confirmation. Check this transaction before signing anything again.' } : {}) };
  }
  async verifyMint(value, { tokenAccount } = {}) {
    let mint;
    try { mint = new PublicKey(value); } catch { problem(400, 'INVALID_ADDRESS', 'Enter a valid Fee Key mint address.'); }
    let tokenAddress, minimumSlot;
    if (tokenAccount !== undefined) {
      try { tokenAddress = new PublicKey(tokenAccount); } catch { problem(400, 'INVALID_TOKEN_ACCOUNT', 'Enter a valid SPL token account address.'); }
    } else {
      let largest;
      try { largest = await this.connection.getTokenLargestAccounts(mint, 'confirmed'); }
      catch { problem(502, 'HOLDER_LOOKUP_UNAVAILABLE', 'The RPC provider could not resolve the current holder. Supply a tokenAccount address to verify it directly.'); }
      const candidates = largest.value.filter(account => account.amount === '1' && account.decimals === 0);
      if (candidates.length !== 1) problem(422, 'NOT_UNIQUE_NFT', 'This mint does not have one unique Fee Key holder.');
      tokenAddress = candidates[0].address; minimumSlot = largest.context.slot;
    }
    // A supplied account is an untrusted lookup hint. It never substitutes for
    // live token ownership, exact mint matching or canonical protocol checks.
    const snapshot = await this.connection.getAccountInfoAndContext(tokenAddress, { commitment: 'confirmed', ...(minimumSlot === undefined ? {} : { minContextSlot: minimumSlot }) });
    const state = snapshot.value;
    let holder;
    try {
      if (!state || state.executable || !state.owner.equals(TOKEN_PROGRAM_ID) || state.data.length !== ACCOUNT_SIZE) throw Error();
      holder = unpackAccount(tokenAddress, state, TOKEN_PROGRAM_ID);
    }
    catch { problem(422, 'INVALID_TOKEN_ACCOUNT', 'The current holder account is not a supported SPL token account.'); }
    if (!holder.mint.equals(mint)) problem(422, 'TOKEN_MINT_MISMATCH', 'This token account belongs to a different mint.');
    const proof = await this.verifyFeeKey({ connection: this.connection, cluster: this.cluster, mint, owner: holder.owner, tokenAccount: tokenAddress, minContextSlot: snapshot.context.slot });
    if (!proof?.verified) problem(422, 'UNVERIFIED_FEE_KEY', 'Raydium Fee Key verification failed.');
    return { verified: true, readOnly: true, observedAt: iso(this.now()), signingFlowSupported: PublicKey.isOnCurve(holder.owner.toBytes()), feeKey: proof,
      scope: 'Raydium CPMM Burn & Earn account verification. This does not create a listing, prove a Sona sale, or authorize a transaction.' };
  }
}
