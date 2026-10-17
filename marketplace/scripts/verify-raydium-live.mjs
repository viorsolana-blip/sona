import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Connection } from '@solana/web3.js';
import { verifyFeeKey } from '../src/chain/raydium.mjs';

// A public third-party position used only to verify read compatibility, never as a listing.
const reference = Object.freeze({
  mint: 'GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o',
  owner: 'AKesWP7KUE9QSnZuU35yQE8HcWQbTsRGMKAbaqESHVrx',
  tokenAccount: '6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7',
  publicRaydiumTransaction: 'AAHxBXqDGg8HnsBdjSoUgEjs288PYNcJtD9U7ASHuquBqaAFVHrNfbokVviApUp1LHLS8JC5UMDJA2P2ZAQtfPo',
});
const root = new URL('../', import.meta.url);
const output = new URL('evidence/raydium-mainnet-read.json', root);
const defaultRpc = 'https://api.mainnet-beta.solana.com';
const endpoint = process.env.SONA_MAINNET_RPC_URL || defaultRpc;

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--no-write')) throw new Error('Only --no-write is supported.');
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== 'https:') throw new Error('A secure mainnet RPC endpoint is required.');
  const connection = new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true });
  // Authenticate the cluster; an endpoint returning devnet data is not mainnet evidence.
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw new Error('RPC genesis hash is not Solana mainnet-beta.');
  const verification = await verifyFeeKey({ connection, cluster: 'mainnet-beta', commitment: 'finalized', ...reference });
  const sourceHashes = {};
  for (const relative of ['src/chain/raydium.mjs', 'tests/raydium.test.mjs', 'scripts/verify-raydium-live.mjs']) {
    sourceHashes[relative] = createHash('sha256').update(await readFile(new URL(relative, root))).digest('hex');
  }
  const report = {
    schemaVersion: 1, kind: 'raydium-mainnet-read', verified: true,
    observedAt: new Date().toISOString(), rpcOrigin: parsedEndpoint.origin, genesisHash,
    statement: 'Read-only verification of an existing third-party Raydium CPMM Fee Key. This is not a Sona sale, listing, user, controlled wallet or settlement receipt.',
    networkWrites: 0, publicReference: reference, sourceHashes, verification,
  };
  if (!process.argv.includes('--no-write')) {
    await mkdir(new URL('evidence/', root), { recursive: true });
    const temporary = new URL('evidence/raydium-mainnet-read.json.tmp', root);
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
    await rename(temporary, output);
  }
  console.log(JSON.stringify({ ...report, output: process.argv.includes('--no-write') ? null : fileURLToPath(output) }, null, 2));
}

main().catch(error => {
  // Preserve the prior dated proof on transient failure. Do not leak RPC keys from provider errors.
  console.error(JSON.stringify({ verified: false, code: error.code || 'LIVE_VERIFICATION_FAILED',
    message: 'Read-only verification failed; the prior dated artifact has not been overwritten. Check RPC availability and whether the public reference owner still holds this Fee Key.' }));
  process.exitCode = 1;
});
