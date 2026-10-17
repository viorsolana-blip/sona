// Exact public-input handling; this module has no wallet or network capabilities.
export const isAddress = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export function lamportsFromSol(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,10})(\.\d{1,9})?$/.test(value)) throw new Error('Enter a positive SOL amount with at most nine decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0'));
  if (amount <= 0n || amount > 1000000000000000n) throw new Error('Enter a price between one lamport and 1,000,000 SOL.');
  return amount.toString();
}
export function decimalUnits(value, decimals = 9) {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid exact amount.');
  const amount = BigInt(value), scale = 10n ** BigInt(decimals);
  if (decimals === 0) return amount.toString();
  const fractional = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${amount / scale}${fractional ? `.${fractional}` : ''}`;
}
export function savedPublicFields(raw) {
  const clean = { seller: '', buyer: '', mint: '', price: '0.000001' };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return clean;
    for (const key of ['seller', 'buyer', 'mint']) if (isAddress(value[key])) clean[key] = value[key];
    try { lamportsFromSol(value.price); clean.price = value.price; } catch {}
  } catch {}
  return clean;
}
/** An aborted fetch can still resolve. Only the latest unchanged request may render. */
export function requestGate() {
  let generation = 0, controller;
  const invalidate = () => { generation++; controller?.abort(); controller = undefined; };
  return { invalidate, start() {
    invalidate(); controller = new AbortController();
    const current = generation;
    return { signal: controller.signal, current: () => current === generation };
  } };
}

export function assertQuoteMatches(data, input) {
  const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
  const chainRead = value => value?.cluster === 'mainnet-beta' && value.genesisHash === genesis
    && value.commitment === 'finalized' && value.networkWrites === 0 && value.transactionsSent === 0;
  let matches = data?.schemaVersion === 1 && data.kind === 'sona-setup-quote' && data.readOnly === true && chainRead(data)
    && data.wallets?.seller?.address === input.seller && data.wallets?.buyer?.address === input.buyer && data.pool?.verified === true;
  if (input.feeKeyMint) {
    const preflight = data?.settlement;
    matches &&= data.mode === 'existing-fee-key' && data.creation === null && chainRead(preflight)
      && preflight.kind === 'mainnet-sale-preflight' && preflight.verified === true
      && preflight.terms?.seller === input.seller && preflight.terms?.buyer === input.buyer
      && preflight.terms?.mint === input.feeKeyMint && preflight.terms?.priceLamports === input.priceLamports;
  } else matches &&= data.mode === 'create-fee-key' && data.settlement === null && data.creation?.allInCostLamports === null;
  if (!matches) throw new Error('The returned check does not match these terms. Please retry.');
}
