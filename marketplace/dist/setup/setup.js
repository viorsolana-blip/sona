import { createWalletController, shortAddress } from '../app/wallet.js';
import { isAddress, lamportsFromSol, decimalUnits, savedPublicFields, requestGate, assertQuoteMatches } from './state.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'sona.settlement-setup.v1';
const fields = ['seller', 'buyer', 'mint', 'price'];
const quoteGate = requestGate(), inventoryGate = requestGate();
let lastQuote = null, connected = null;
const sol = value => `${decimalUnits(value)} SOL`;
const say = (id, text, error = false) => { $(id).textContent = text; $(id).classList.toggle('error', error); };
const remember = () => {
  // Persist only syntactically valid public fields; never store arbitrary pasted text.
  const values = Object.fromEntries(fields.map(key => [key, $(key).value.trim()]));
  try { sessionStorage.setItem(storageKey, JSON.stringify(savedPublicFields(JSON.stringify(values)))); } catch {}
};
function invalidate() {
  quoteGate.invalidate(); lastQuote = null;
  $('check').disabled = false; $('check').textContent = 'Check readiness ↗';
  $('download').disabled = true; $('download').textContent = 'Save cost check';
  $('quote-values').replaceChildren(); $('quote-notes').replaceChildren();
  say('quote-state', 'Check the current addresses and terms for a fresh breakdown.');
  say('status', 'No transactions are created or sent by this page.');
}
function invalidateInventory() {
  inventoryGate.invalidate(); $('inventory').replaceChildren(); $('find-keys').disabled = false;
  say('inventory-status', '');
}
const wallet = createWalletController({ chain: 'solana:mainnet', onChange(state) {
  connected = state.connected ? state : null;
  say('connection-status', connected ? `${state.name} · ${shortAddress(state.address)}` : 'No wallet connected');
  $('connection-status').title = connected?.address || '';
  $('connect').hidden = !!connected; $('disconnect').hidden = !connected;
  document.querySelectorAll('.capture').forEach(button => button.disabled = !connected);
  // A provider account change never silently changes either saved participant.
  invalidate();
} });

try {
  const saved = savedPublicFields(sessionStorage.getItem(storageKey));
  fields.forEach(key => { $(key).value = saved[key]; });
} catch {}
fields.forEach(key => $(key).addEventListener('input', () => {
  invalidate(); remember();
  if (key === 'seller') { invalidateInventory(); say('seller-origin', 'Public address entered. Ownership has not been authenticated.'); }
  if (key === 'buyer') say('buyer-origin', 'Public address entered. Ownership has not been authenticated.');
}));

$('connect').addEventListener('click', () => {
  const list = wallet.list(), container = $('wallet-options'); container.replaceChildren();
  say('wallet-message', list.length ? 'Connection does not request a signature or move funds.' : 'No compatible wallet was detected. Open this page in a browser with your Solana wallet, or paste its public address to check costs.');
  const brands = { phantom: 'phantom.svg', solflare: 'solflare.svg', backpack: 'backpack.png' };
  for (const option of list) {
    const button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button';
    const file = brands[option.name.toLowerCase()];
    if (file) { const logo = document.createElement('img'); logo.src = `../assets/brands/${file}`; logo.alt = ''; button.append(logo); }
    button.append(document.createTextNode(option.name));
    button.addEventListener('click', async () => {
      container.querySelectorAll('button').forEach(item => item.disabled = true);
      say('wallet-message', 'Approve the connection in your wallet.');
      try { await wallet.connect(option.id); $('wallet-dialog').close(); }
      catch { say('wallet-message', 'Connection was not completed. You can retry or paste a public address.', true); }
      finally { container.querySelectorAll('button').forEach(item => item.disabled = false); }
    }); container.append(button);
  }
  $('wallet-dialog').showModal();
});
$('close-dialog').addEventListener('click', () => $('wallet-dialog').close());
$('disconnect').addEventListener('click', async () => {
  try { await wallet.disconnect(); } catch { say('status', 'Disconnect in your wallet if the provider is not responding.', true); }
});
document.querySelectorAll('.capture').forEach(button => button.addEventListener('click', () => {
  const role = button.dataset.role;
  if (!connected || !isAddress(wallet.address) || !['seller', 'buyer'].includes(role)) return;
  $(role).value = wallet.address;
  say(`${role}-origin`, 'Captured from the connected wallet. Marketplace authentication is still required.');
  invalidate(); if (role === 'seller') invalidateInventory(); remember();
}));

async function api(path, options) {
  const response = await fetch(path, { credentials: 'omit', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The connection is temporarily unavailable. Please retry the check.'); }
  if (!response.ok) throw new Error(data.error?.message || 'The chain data could not be read. Please retry.');
  return data;
}
$('find-keys').addEventListener('click', async () => {
  const seller = $('seller').value.trim();
  if (!isAddress(seller)) return say('inventory-status', 'Enter a valid seller public address first.', true);
  const request = inventoryGate.start(); $('find-keys').disabled = true; $('inventory').replaceChildren();
  say('inventory-status', 'Checking the seller’s wallet for supported Fee Keys…');
  try {
    const data = await api(`/api/wallet/${encodeURIComponent(seller)}`, { signal: request.signal });
    if (!request.current()) return;
    const positions = (data.positions || []).filter(position => isAddress(position.mint));
    say('inventory-status', positions.length ? `${positions.length} eligible Fee Key${positions.length === 1 ? '' : 's'} found. Select one below.${data.truncated ? ' This scan is partial; paste a mint to check another key directly.' : ''}`
      : data.truncated ? 'No eligible Fee Key was found in this partial scan. Paste its mint to check it directly.' : 'No eligible Fee Key was found. After creating one on Raydium, check again.');
    for (const position of positions) {
      const button = document.createElement('button'); button.className = 'button secondary'; button.type = 'button';
      const label = document.createElement('span'); label.textContent = `${position.base} / ${position.quote} · Fee rights`;
      const mint = document.createElement('small'); mint.textContent = position.mint; button.append(label, mint);
      button.addEventListener('click', () => { $('mint').value = position.mint; invalidate(); remember(); $('check').focus(); });
      $('inventory').append(button);
    }
  } catch (error) { if (request.current()) say('inventory-status', error.message, true); }
  finally { if (request.current()) $('find-keys').disabled = false; }
});

function row(label, value) {
  const group = document.createElement('div'), term = document.createElement('dt'), definition = document.createElement('dd');
  term.textContent = label;
  if (value instanceof Node) definition.append(value); else definition.textContent = value;
  group.append(term, definition); $('quote-values').append(group);
}
function note(value) { const p = document.createElement('p'); p.textContent = value; $('quote-notes').append(p); }
function renderQuote(data) {
  $('quote-values').replaceChildren(); $('quote-notes').replaceChildren();
  row('Seller balance', sol(data.wallets.seller.nativeBalanceLamports));
  row(data.settlement ? 'Buyer balance at preflight' : 'Buyer balance', sol(data.settlement?.costs?.buyerBalanceLamports ?? data.wallets.buyer.nativeBalanceLamports));
  if (data.settlement) {
    const costs = data.settlement.costs;
    row('Fee Key price', sol(costs.priceLamports)); row('Network fee', sol(costs.networkFeeLamports));
    row('Buyer token account rent', sol(costs.buyerAtaRentLamports));
    row('Estimated buyer debit', sol(costs.totalEstimatedBuyerDebitLamports));
    row('Additional buyer balance needed', sol(costs.additionalLamportsNeeded));
    say('quote-state', data.settlement.readyToSettle ? 'Fee Key verified. The buyer has sufficient SOL at the checked slot.' : 'Fee Key verified. The buyer needs more SOL for this settlement.');
    note(`Buyer funding was checked at finalized slot ${data.settlement.snapshotSlot}. The separate wallet observation is slot ${data.wallets.snapshotSlot}. The marketplace checks the asset and costs again when preparing the actual sale.`);
    $('download').textContent = 'Save settlement preflight';
  } else {
    const creation = data.creation;
    row('Seller’s USDC account', `${decimalUnits(creation.sellerTokenAccounts.usdc.amount, 6)} USDC`);
    row('Known lock account rent', sol(creation.lockAccountRent.knownSubtotalLamports));
    row('Conditional seller account rent', sol(creation.missingSellerTokenAccountRentLamports));
    row('Total creation cost', 'Awaiting Raydium quote');
    say('quote-state', 'Pool verified. Account rent is available; the deposit and lock still need a quote.');
    note('These rent components are not a total funding amount. Raydium must quote the deposit, transaction fees and any metadata or protocol costs.');
    note('USDC and LP balances cover the seller’s canonical token accounts only. Wrapped SOL may use a temporary account, so account rent can differ.');
    if (Object.values(creation.sellerTokenAccounts).some(account => account.delegated || account.thirdPartyCloseAuthority)) note('A seller token account has delegated access or another close authority. Review its permissions before using it.');
    $('creation-guide').open = true;
  }
  if (isAddress(data.pool?.address)) {
    const link = document.createElement('a'); link.href = `https://solscan.io/account/${data.pool.address}`;
    link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = data.pool.address;
    row('Verified CPMM pool', link);
  }
  note(`Observed ${new Date(data.observedAt).toLocaleString()}. Balances and network costs can change. Recheck immediately before the sale.`);
}
$('check').addEventListener('click', async () => {
  invalidate();
  const seller = $('seller').value.trim(), buyer = $('buyer').value.trim(), feeKeyMint = $('mint').value.trim();
  let priceLamports;
  try {
    if (!isAddress(seller) || !isAddress(buyer)) throw new Error('Enter both public wallet addresses before checking costs.');
    if (seller === buyer) throw new Error('Use two different wallets for seller and buyer.');
    if (feeKeyMint && !isAddress(feeKeyMint)) throw new Error('Enter a valid Fee Key mint address, or leave it empty to check creation costs.');
    priceLamports = lamportsFromSol($('price').value.trim());
  } catch (error) { say('status', error.message, true); return; }
  const input = { seller, buyer, priceLamports, ...(feeKeyMint ? { feeKeyMint } : {}) };
  remember(); const request = quoteGate.start(); $('check').disabled = true; $('check').textContent = 'Checking mainnet…';
  say('status', 'Reading finalized mainnet state. No signature is requested.');
  try {
    const data = await api('/api/setup/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: request.signal });
    if (!request.current()) return;
    assertQuoteMatches(data, input);
    renderQuote(data); lastQuote = data; $('download').disabled = false;
    say('status', 'Cost check complete. Save it before continuing.');
  } catch (error) { if (request.current()) { lastQuote = null; $('download').disabled = true; $('quote-values').replaceChildren(); $('quote-notes').replaceChildren(); say('status', error.message, true); say('quote-state', 'No current cost check. Please resolve the issue and retry.'); } }
  finally { if (request.current()) { $('check').disabled = false; $('check').textContent = 'Check readiness ↗'; } }
});
$('download').addEventListener('click', () => {
  if (!lastQuote) return;
  const value = lastQuote.settlement || lastQuote;
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = lastQuote.settlement ? 'sona-mainnet-sale-preflight.json' : 'sona-setup-cost-check.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('clear').addEventListener('click', () => {
  fields.forEach(key => $(key).value = key === 'price' ? '0.000001' : '');
  try { sessionStorage.removeItem(storageKey); } catch {}
  invalidate(); invalidateInventory();
  say('seller-origin', 'Public address only. Never enter a seed phrase.');
  say('buyer-origin', 'Switch accounts in your wallet to capture a second address.');
  say('status', 'Saved addresses and cost checks cleared.');
});
