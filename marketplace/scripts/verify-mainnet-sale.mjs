import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { normalizeSaleTerms, preflightMainnetSale, verifyMainnetSale } from '../src/verification/mainnet-sale.mjs';

const sonaOrigin = 'https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site';
const help = `Read-only Sona mainnet verification. No keys, signing, broadcasts or funding.

node scripts/verify-mainnet-sale.mjs preflight --terms /absolute/public-terms.json --out /absolute/preflight.json
node scripts/verify-mainnet-sale.mjs receipt --terms /absolute/public-terms.json --signature PUBLIC_SIGNATURE [--preflight /absolute/preflight.json] [--expected-message-sha256 HASH] [--check-sona] [--out /absolute/receipt.json]

Terms JSON has exactly: mint, seller, buyer, sourceTokenAccount, priceLamports.
All addresses are public; priceLamports is a positive integer string.
Default RPC is free https://solana-rpc.publicnode.com. SONA_MAINNET_RPC_URL may override it.
--check-sona requires an exact match on the public Sona receipts API; it never submits a trade.
The verifier cannot infer whether two wallets have independent owners or whether a transfer was a commercial sale.`;

async function readJson(path) {
  const text = await readFile(resolve(path), 'utf8');
  if (text.length > 1_000_000) throw new Error('Input JSON exceeds the verification file size limit.');
  return JSON.parse(text);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) { console.log(help); return; }
  const mode = args.shift();
  if (!['preflight', 'receipt'].includes(mode)) throw new Error('Select preflight or receipt.');
  const options = {};
  const valued = new Set(['--terms', '--out', '--signature', '--preflight', '--expected-message-sha256']);
  while (args.length) {
    const key = args.shift();
    if (Object.hasOwn(options, key) || (!valued.has(key) && key !== '--check-sona')) throw new Error('Unknown or duplicate option.');
    if (key === '--check-sona') options[key] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('An option value is missing.');
      options[key] = value;
    }
  }
  if (!options['--terms']) throw new Error('--terms must identify a JSON file containing only public sale terms.');
  if (mode === 'preflight' && ['--signature', '--preflight', '--expected-message-sha256', '--check-sona'].some(key => options[key])) throw new Error('Receipt options cannot be used for a preflight.');
  if (mode === 'receipt' && !options['--signature']) throw new Error('--signature is required for receipt verification.');
  const terms = await readJson(options['--terms']);
  normalizeSaleTerms(terms);
  const endpoint = process.env.SONA_MAINNET_RPC_URL || 'https://solana-rpc.publicnode.com';
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a secure HTTPS mainnet RPC without URL user information.');
  const connection = new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }) });
  let sonaReceipt;
  if (options['--check-sona']) {
    const response = await fetch(`${sonaOrigin}/api/receipts`, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('The public Sona receipts endpoint is unavailable.');
    const text = await response.text();
    if (text.length > 1_000_000) throw new Error('The public receipt response exceeds the size limit.');
    const body = JSON.parse(text);
    if (!Array.isArray(body.receipts)) throw new Error('The public Sona receipts response has an unsupported shape.');
    const matches = body.receipts.filter(receipt => receipt.signature === options['--signature']);
    if (matches.length !== 1) throw new Error('There is no unique finalized Sona receipt for this signature.');
    sonaReceipt = matches[0];
  }
  const report = mode === 'preflight' ? await preflightMainnetSale({ connection, terms }) : await verifyMainnetSale({
    connection, terms, signature: options['--signature'],
    preflight: options['--preflight'] ? await readJson(options['--preflight']) : undefined,
    expectedMessageSha256: options['--expected-message-sha256'], sonaReceipt,
  });
  if (sonaReceipt) {
    report.sonaAttribution = 'Matches the receipt fetched from the public Sona marketplace API and the finalized transaction.';
    report.publicSonaReceipt = { endpoint: `${sonaOrigin}/api/receipts`, observedAt: new Date().toISOString(), receipt: sonaReceipt,
      note: 'This establishes public marketplace correspondence, not independent counterparties or organic demand.' };
  }
  report.rpcOrigin = url.origin;
  report.sourceHashes = {};
  for (const path of ['src/verification/mainnet-sale.mjs', 'scripts/verify-mainnet-sale.mjs', 'src/chain/raydium.mjs', 'src/chain/settlement.mjs', 'src/server/network.mjs']) {
    report.sourceHashes[path] = createHash('sha256').update(await readFile(new URL(`../${path}`, import.meta.url))).digest('hex');
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options['--out']) {
    const output = resolve(options['--out']);
    await mkdir(dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, serialized, { flag: 'wx' });
    await rename(temporary, output);
  }
  console.log(serialized.trimEnd());
}

main().catch(error => {
  // RPC exceptions may include credential-bearing endpoint URLs; do not echo them.
  console.error(JSON.stringify({ verified: false, code: error.code || 'VERIFICATION_FAILED',
    message: error.name === 'MainnetVerificationError' || error.name === 'SettlementError' || error.name === 'RaydiumEligibilityError'
      ? error.message : 'Verification did not complete. Check public input terms, RPC availability, finality, and current Fee Key ownership. No successful evidence file was written.',
    networkWrites: 0, transactionsSent: 0 }));
  process.exitCode = 1;
});
