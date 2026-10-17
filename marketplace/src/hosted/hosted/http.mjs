import { createHash } from 'node:crypto';
import { ApiError } from './marketplace.mjs';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Send an application/json request.');
  if (Number(request.headers.get('content-length')) > 16_384) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader(), chunks = []; let length = 0;
  if (reader) {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new ApiError(413, 'BODY_TOO_LARGE', 'Request is too large.'); }
      chunks.push(value);
    }
  }
  try {
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const result = JSON.parse(new TextDecoder().decode(bytes) || '{}');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error();
    return result;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'Request must be a JSON object.'); }
}

/** Only handles API requests; the Sites asset handler owns every other path. */
export async function handleApi(request, { market, origin, store = market.store }) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) return null;
  try {
    if (url.origin !== origin) throw new ApiError(400, 'HOST_MISMATCH', 'Use the configured Sona origin.');
    if (path.length > 512) throw new ApiError(414, 'PATH_TOO_LONG', 'The request path is too long.');
    const method = request.method, mutating = !['GET', 'HEAD'].includes(method);
    if (mutating && request.headers.get('origin') && request.headers.get('origin') !== origin) throw new ApiError(403, 'ORIGIN_MISMATCH', 'Cross-origin requests are not allowed.');
    if (mutating && request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError(403, 'ORIGIN_MISMATCH', 'Cross-site requests are not allowed.');
    // Cloudflare supplies this header at the public edge. Only its digest is
    // retained, for a two-minute rate-limit window; IP addresses are not stored.
    const client = request.headers.get('cf-connecting-ip') || 'unknown';
    const rateKey = createHash('sha256').update(`${origin}\0${client}`).digest('hex');
    if (!await store.rateLimit(rateKey, Date.now())) throw new ApiError(429, 'RATE_LIMIT', 'Too many requests. Wait a moment and retry.');
    const token = request.headers.get('authorization')?.replace(/^Bearer /, ''), owner = await market.session(token);
    const auth = () => { if (!owner) throw new ApiError(401, 'AUTH_REQUIRED', 'Authenticate your connected wallet first.'); return owner; };
    let output;
    if (method === 'GET' && path === '/api/config') output = {
      cluster: market.cluster, genesisHash: market.genesisHash, settlementMode: 'co-signed', tradingEnabled: true,
      protocol: 'Raydium CPMM Burn & Earn', origin, persistence: 'Cloudflare D1',
      networkFees: 'Buyer pays Solana network and token account rent fees. Seller approves each purchase.',
    };
    else if (method === 'GET' && path === '/api/listings') {
      const offset = Number(url.searchParams.get('offset') || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 4000) throw new ApiError(400, 'INVALID_OFFSET', 'Offset must be between zero and 4000.');
      output = await market.listings({ offset });
    } else if (method === 'GET' && path === '/api/receipts') {
      const receipts = await store.all('receipt');
      output = { receipts: receipts.slice(0, 50), total: receipts.length };
    } else if (method === 'GET' && /^\/api\/verify\/[^/]+$/.test(path)) output = await market.verifyMint(decodeURIComponent(path.slice(12)));
    else if (method === 'GET' && /^\/api\/wallet\/[^/]+$/.test(path)) output = await market.wallet(decodeURIComponent(path.slice(12)), owner);
    else if (method === 'POST' && path === '/api/auth/challenge') output = await market.challenge((await body(request)).address);
    else if (method === 'POST' && path === '/api/auth/verify') output = await market.authenticate(await body(request));
    else if (method === 'POST' && path === '/api/auth/logout') { await market.logout(token); output = { ok: true }; }
    else if (method === 'POST' && path === '/api/listings') output = await market.createListing(auth(), await body(request));
    else if (/^\/api\/listings\/[^/]+(?:\/request)?$/.test(path)) {
      const id = path.split('/')[3];
      if (method === 'POST' && path.endsWith('/request')) { await body(request); output = await market.requestPurchase(auth(), id); }
      else if (method === 'PATCH') output = await market.changeListing(auth(), id, await body(request));
      else if (method === 'DELETE') output = await market.changeListing(auth(), id, {}, true);
      else throw new ApiError(405, 'METHOD', 'Unsupported listing method.');
    } else if (/^\/api\/trades\/[^/]+(?:\/(prepare|approve|submit|cancel))?$/.test(path)) {
      const [, , , id, action] = path.split('/'); auth();
      if (method === 'GET' && !action) output = await market.trade(owner, id);
      else if (method === 'POST') {
        const input = await body(request);
        if (action === 'prepare') output = await market.prepare(owner, id);
        else if (action === 'approve') output = await market.approve(owner, id, input.transactionBase64);
        else if (action === 'submit') output = await market.submit(owner, id, input.transactionBase64);
        else if (action === 'cancel') output = await market.cancel(owner, id);
        else throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
      } else throw new ApiError(405, 'METHOD', 'Unsupported purchase method.');
    } else throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found.');
    return json(output);
  } catch (error) {
    const known = error instanceof ApiError || ['SettlementError', 'RaydiumEligibilityError', 'StoreError'].includes(error.name);
    const code = typeof error.code === 'string' ? error.code : 'UPSTREAM_UNAVAILABLE';
    const status = error.status || (error.name === 'RaydiumEligibilityError' ? 422 : code.startsWith('INVALID_') ? 400 : 502);
    return json({ error: { code, message: known ? error.message : 'The Solana data request could not be completed. Retry shortly; no successful trade is assumed.' } }, status);
  }
}

export default handleApi;
