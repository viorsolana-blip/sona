import { getWallets } from '@wallet-standard/app';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

const addressOf = value => value ? new PublicKey(value.toString()).toBase58() : null;
export const shortAddress = address => address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '';
export const bytesToBase64 = bytes => btoa(String.fromCharCode(...bytes));
export const base64ToBytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const equalBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Reconstruct the three permitted sale instructions from the reviewed terms. */
export function assertSettlementTransaction(transactionBase64, terms) {
  if (!/^[1-9][0-9]*$/.test(terms.priceLamports) || BigInt(terms.priceLamports) > (1n << 64n) - 1n) throw new Error('Invalid sale price.');
  const seller = new PublicKey(terms.seller), buyer = new PublicKey(terms.buyer);
  const mint = new PublicKey(terms.mint), source = new PublicKey(terms.sourceTokenAccount);
  if (seller.equals(buyer)) throw new Error('Buyer and seller must be different wallets.');
  const actual = Transaction.from(base64ToBytes(transactionBase64));
  const destination = getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_PROGRAM_ID);
  const expected = new Transaction({ feePayer: buyer, recentBlockhash: terms.blockhash });
  expected.add(
    createAssociatedTokenAccountIdempotentInstruction(buyer, destination, buyer, mint, TOKEN_PROGRAM_ID),
    createTransferCheckedInstruction(source, mint, destination, seller, 1n, 0, [], TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: buyer, toPubkey: seller, lamports: BigInt(terms.priceLamports) }),
  );
  if (!equalBytes(actual.serializeMessage(), expected.serializeMessage())) throw new Error('Transaction does not match the reviewed Fee Key, buyer, seller and price. No signature requested.');
  return true;
}

/** Signers stay in the wallet extension; Sona only receives public keys and signatures. */
export function createWalletController({ host = globalThis.window, registry = getWallets(), onChange = () => {}, chain = 'solana:mainnet' } = {}) {
  let current = null;
  let address = null;
  let cleanups = [];
  let generation = 0;
  const emit = () => onChange({ address, name: current?.name || null, connected: Boolean(address) });
  const cleanup = () => { cleanups.forEach(fn => fn()); cleanups = []; };
  const clear = () => { generation++; cleanup(); current = null; address = null; emit(); };
  function list() {
    const candidates = [];
    for (const wallet of registry.get()) {
      const f = wallet.features;
      if (!wallet.chains?.includes(chain) || !f['standard:connect'] || !f['solana:signMessage'] || !f['solana:signTransaction']) continue;
      candidates.push({ id: `standard:${wallet.name}`, name: wallet.name, kind: 'standard', wallet });
    }
    const injected = [
      ['Phantom', host?.phantom?.solana || (host?.solana?.isPhantom ? host.solana : null)],
      ['Solflare', host?.solflare],
      ['Backpack', host?.backpack?.solana || (host?.backpack?.isBackpack ? host.backpack : null)],
    ];
    for (const [name, provider] of injected) {
      if (provider?.connect && provider?.signMessage && provider?.signTransaction && !candidates.some(item => item.name.toLowerCase() === name.toLowerCase())) candidates.push({ id: `injected:${name}`, name, kind: 'injected', provider });
    }
    return candidates;
  }
  async function connect(id) {
    const selected = list().find(item => item.id === id);
    if (!selected) throw new Error('This wallet is not available in this browser. Open Sona in the browser where your wallet is installed.');
    if (current) await disconnect();
    const token = ++generation;
    let nextAddress;
    if (selected.kind === 'standard') {
      const response = await selected.wallet.features['standard:connect'].connect();
      const account = response.accounts.find(item => item.chains.includes(chain) && item.features.includes('solana:signMessage') && item.features.includes('solana:signTransaction'));
      if (!account) throw new Error('Choose a Solana account with message and transaction signing enabled.');
      selected.account = account;
      nextAddress = addressOf(account.address);
    } else {
      const result = await selected.provider.connect();
      nextAddress = addressOf(result?.publicKey || selected.provider.publicKey);
      if (!nextAddress) throw new Error('The wallet did not return an account.');
    }
    if (token !== generation) throw new Error('The wallet connection changed. Connect again.');
    current = selected;
    address = nextAddress;
    if (selected.kind === 'standard') {
      const events = selected.wallet.features['standard:events'];
      if (events) cleanups.push(events.on('change', event => {
        if (!event.accounts) return;
        // Account changes invalidate the API session and outstanding signature requests.
        const account = event.accounts.find(item => item.chains.includes(chain) && item.features.includes('solana:signMessage') && item.features.includes('solana:signTransaction'));
        if (!account) { clear(); return; }
        generation++; selected.account = account; address = addressOf(account.address); emit();
      }));
    } else if (selected.provider.on) {
      const changed = key => { if (!key) clear(); else { generation++; address = addressOf(key); emit(); } };
      const disconnected = () => clear();
      selected.provider.on('accountChanged', changed);
      selected.provider.on('disconnect', disconnected);
      cleanups.push(() => { selected.provider.removeListener?.('accountChanged', changed); selected.provider.removeListener?.('disconnect', disconnected); });
    }
    emit();
    return { address, name: current.name };
  }
  async function disconnect() {
    const previous = current;
    clear();
    if (previous?.kind === 'standard') await previous.wallet.features['standard:disconnect']?.disconnect();
    else await previous?.provider.disconnect?.();
  }
  function signer() {
    if (!current || !address) throw new Error('Connect your wallet first.');
    return { selected: current, expectedAddress: address, token: generation };
  }
  function assertUnchanged(snapshot) {
    if (snapshot.token !== generation || snapshot.expectedAddress !== address) throw new Error('Your wallet account changed. Review the action again.');
  }
  async function signMessage(message) {
    const snapshot = signer();
    const bytes = new TextEncoder().encode(message);
    let signature;
    if (snapshot.selected.kind === 'standard') {
      const [result] = await snapshot.selected.wallet.features['solana:signMessage'].signMessage({ account: snapshot.selected.account, message: bytes });
      if (!result?.signedMessage || !equalBytes(result.signedMessage, bytes)) throw new Error('The wallet changed the message. Signature rejected.');
      signature = result.signature;
    } else {
      const result = await snapshot.selected.provider.signMessage(bytes, 'utf8');
      signature = result.signature || result;
    }
    assertUnchanged(snapshot);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new Error('The wallet returned an invalid message signature.');
    return bytesToBase64(signature);
  }
  async function signTransaction(transactionBase64) {
    const snapshot = signer();
    const bytes = base64ToBytes(transactionBase64);
    const transaction = Transaction.from(bytes);
    const originalMessage = transaction.serializeMessage();
    const signerEntry = transaction.signatures.find(item => item.publicKey.toBase58() === snapshot.expectedAddress);
    if (!signerEntry) throw new Error('This transaction does not require your wallet signature.');
    let signed;
    if (snapshot.selected.kind === 'standard') {
      const [result] = await snapshot.selected.wallet.features['solana:signTransaction'].signTransaction({ account: snapshot.selected.account, chain, transaction: bytes });
      signed = Transaction.from(result.signedTransaction);
    } else signed = await snapshot.selected.provider.signTransaction(transaction);
    assertUnchanged(snapshot);
    if (!equalBytes(originalMessage, signed.serializeMessage())) throw new Error('The wallet changed the transaction. Signature rejected.');
    const signature = signed.signatures.find(item => item.publicKey.toBase58() === snapshot.expectedAddress)?.signature;
    if (!signature || !signed.verifySignatures(false)) throw new Error('The wallet returned an invalid transaction signature.');
    return bytesToBase64(signed.serialize({ requireAllSignatures: false, verifySignatures: true }));
  }
  function setChain(next) {
    const value = next === 'mainnet-beta' ? 'solana:mainnet' : next.startsWith('solana:') ? next : `solana:${next}`;
    if (!['solana:mainnet', 'solana:devnet', 'solana:testnet'].includes(value)) throw new Error('Unsupported Solana cluster.');
    if (chain !== value) { clear(); chain = value; }
  }
  return { list, connect, disconnect, signMessage, signTransaction, setChain, get address() { return address; } };
}
