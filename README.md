# Sona

A marketplace for **Raydium CPMM Burn & Earn Fee Keys** on Solana. Holders can list the fee rights represented by a verified Fee Key NFT. A buyer requests a purchase, the seller approves the exact transaction, and both wallets sign an atomic exchange of the NFT for SOL. The underlying liquidity stays locked in Raydium.

[Website](https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site/) · [Marketplace](https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site/app/) · [Implementation and evidence](https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site/technical/) · [CI template](https://github.com/viorsolana-blip/sona/blob/main/docs/ci/verify.yml)

## What is implemented

- Wallet Standard and supported injected wallets; signed, expiring authentication challenges.
- On-chain validation of the Fee Key mint, current holder, Raydium lock, pool and locked LP escrow.
- Authenticated listings, price changes, expiry, cancellations and purchase requests.
- Seller approval followed by buyer completion; signatures bind both parties to the exact asset, recipient and SOL amount.
- Atomic settlement through Solana's existing Token, Associated Token and System programs. Sona has no custom settlement program or custody wallet.
- Chain confirmation and receipts, with unsuccessful or expired transactions handled explicitly.

Seller approval is required for every sale. Listing discovery uses hosted storage; it is not an autonomous decentralized order book. Raydium, Solana and wallet software are external dependencies, not technology invented by Sona.

## Two execution environments

| Environment | Purpose | Persistence |
| --- | --- | --- |
| Hosted application at the repository root | Public website and API on the Sites Worker runtime | Cloudflare D1 |
| `marketplace/` | Standalone Node.js server, shared protocol and settlement code, reproducible local tests | Node SQLite |

The supplied site's layout and artwork are retained. The published repository includes the marketplace implementation and the adapter used by the hosted application. Tests against Node/SQLite do **not** by themselves prove Worker/D1 behavior. Use the [public verification guide](docs/PUBLIC-VERIFICATION.md) to distinguish recorded local execution, current public endpoints and on-chain evidence.

## Run the standalone marketplace

Requires Node.js 24 or later. No paid API key is required.

```sh
git clone https://github.com/viorsolana-blip/sona.git
cd sona/marketplace
npm ci
npm run build
npm test
npm start
```

Open `http://127.0.0.1:4173/app/` in a browser with a compatible wallet extension. The default network is Solana mainnet-beta, using the public RPC. Connecting signs an authentication message; it does not transfer assets. There are no seeded listings, invented balances or manufactured trading receipts.

The buyer pays Solana network fees and any required token-account rent. Seller approval expires with its blockhash, so both parties generally need to be available. An already shared signed approval cannot be revoked by a website cancellation while the underlying transaction remains valid.

See [standalone setup and configuration](marketplace/README.md) for environment variables and storage requirements.

## Build the hosted source

```sh
npm ci
npm --prefix marketplace ci
npm --prefix marketplace run build
npm run build
```

The root build uses the checked-in Vinext/Sites build tools and lockfile. It does not require an absolute path to a Codex plugin. A clean clone uses the portable execution profile. `npm start` serves the built Worker locally with Wrangler; a local preview does not publish a site. The checked-in hosting configuration declares nonsecret bindings. No private deployment credentials are included.

## Evidence and limits

The [CI template](docs/ci/verify.yml) defines locked dependency installs, marketplace tests, the wallet build and hosted application compilation. It is **inactive**: the GitHub credential used to publish this repository does not permit workflow publication. Local tests and builds have passed; no GitHub Actions run is claimed. The template uses no paid API key and does not connect a wallet or execute a mainnet purchase.

[Local chain tests](marketplace/scripts/test-backend-local.mjs) exercise real transactions on an isolated Solana validator with newly generated test keys. [Mainnet read verification](marketplace/scripts/verify-raydium-live.mjs) checks a public third-party Fee Key without claiming ownership or selling it. Reports retain their execution scope and source hashes. Neither is evidence of a completed Sona mainnet sale.

The first version excludes CLMM positions, fee claiming, partial rights, principal redemption, confidential settlement, new Raydium locks and program-owned or multisig-held assets. Public RPC can throttle or fail. There is no independent security-audit claim, guaranteed review score, manufactured volume or implied Raydium endorsement.

[Public verification guide](docs/PUBLIC-VERIFICATION.md) · [Protocol provenance](marketplace/evidence/RAYDIUM-SOURCES.md) · [Source and asset provenance](docs/SOURCE-PROVENANCE.md) · [Rights notice](LICENSE)
