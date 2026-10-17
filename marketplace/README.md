# Sona — Raydium Fee Key marketplace

Sona's existing interface now uses an authenticated Node/SQLite marketplace and Solana RPC. The first supported instrument is a **Raydium CPMM Burn & Earn Fee Key**. Assets remain in the owner's wallet. Buyer and seller co-sign one atomic SPL Token/System Program transaction; the seller must approve each purchase. There is no custom Sona escrow program or custody wallet.

## Run locally

Requires Node.js 24 or later. No API key is required.

```sh
npm ci
npm run build
npm start
```

- Website: http://127.0.0.1:4173/
- Marketplace: http://127.0.0.1:4173/app/
- Implementation and evidence: http://127.0.0.1:4173/technical/

Open the marketplace in a browser with Phantom, Solflare, Backpack or a compatible Wallet Standard extension. The Codex in-app browser does not have these extensions installed. Connecting authenticates your wallet with a message; it does not move assets. The marketplace is empty until a real holder lists a verified Fee Key.

## What works

- Real wallet connection, account changes, disconnect, balance and eligible inventory reads.
- Verification against the canonical Raydium lock, pool, NFT, LP escrow and vault accounts.
- Authenticated listings with persistent price, expiry, update and cancellation state.
- Buyer requests, seller partial signatures, buyer completion and exact integer SOL payments.
- Canonical transaction reconstruction in the browser and server; additional instructions or changed terms are rejected.
- Finalized chain confirmation, durable receipts, timeout reconciliation and idempotent submission.
- Existing layout, styles, navigation, filters, portfolio, watchlist and dialogs.

The buyer pays Solana transaction fees and any necessary token-account rent. Creating a listing is free. Seller approval expires with its recent blockhash, usually requiring both parties to be online. An approval already shared cannot be revoked through the website while the transaction remains valid.

## Reproduce the evidence

```sh
npm test
npm run test:chain
npm run verify:raydium
npm run readiness
```

`test:chain` requires `solana-test-validator` (already installed on this machine). It starts an isolated validator, generates fresh test keys in memory, runs actual transactions and removes the test ledger. It uses no existing wallet or real funds. Reports preserve signatures, execution results and source hashes. The validator test in the ordinary unit suite is intentionally skipped because `test:chain` runs it separately.

`verify:raydium` reads a public third-party mainnet Fee Key and writes dated read-only evidence. It does not list, own or sell that asset. `scripts/test-settlement-devnet.mjs` attempts free test funding and records either a public test transaction or the actual blocker. The current faucet attempt failed; no public sale is claimed.

The offline readiness command inventories source and hash-matched recorded evidence. Exit 1 is expected while public deployment, independently observed mainnet settlement, public repository provenance and independent security review remain unverified. A matching hash is not an independent audit or a predicted Larpcheck score.

## Configuration and persistence

Defaults are `127.0.0.1:4173`, mainnet-beta and the free official Solana RPC. The RPC genesis hash is checked before startup. Databases are isolated by network at `var/marketplace-mainnet-beta.sqlite` and `var/marketplace-devnet.sqlite`, and each database records its network identity.

Optional environment variables: `SONA_CLUSTER=devnet`, `PORT`, `HOST`, `SONA_ORIGIN`, `SONA_DB_PATH`, `SONA_RPC_URL`. Public origins require HTTPS. A custom RPC is optional, and its URL is not exposed through the API. Keep `var/` on persistent private storage; never publish it. It contains marketplace state and hashed authentication sessions, not wallet private keys.

Listings are hosted by Sona, not an autonomous decentralized order book. The first version requires ordinary signing wallets; program-owned or multisig-held keys are not supported. It does not support CLMM positions, partial fee rights, fee claiming, principal redemption, confidential settlement or creating new Raydium locks. Public RPC can throttle. Inventory scans are bounded and disclose partial results.

See [implementation notes](docs/TECHNICAL-READINESS.md), [Raydium provenance](evidence/RAYDIUM-SOURCES.md), and [the native dependency replacement](vendor/bigint-buffer/README.md). Original interface fixtures are archived under `archive/local-workspace/` and are not served or used by the application. Brand asset provenance remains in `dist/assets/brands/manifest.json`.
