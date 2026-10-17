# Sona implementation and evidence

Updated 18 October 2026 (Australia/Adelaide). Scope: this checkout, the Node/SQLite reference service, the public Workers/D1 implementation, recorded local validator execution and separate read-only mainnet observations. No Sona mainnet sale or independent security audit is claimed.

Publication state: **public verified**. The HTTPS service is [Sona](https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site), with public source at [viorsolana-blip/sona](https://github.com/viorsolana-blip/sona). The implementation revision checked during publication is [`4749a37ce89ca3ed4228f0cd12bdbbd982f92b21`](https://github.com/viorsolana-blip/sona/tree/4749a37ce89ca3ed4228f0cd12bdbbd982f92b21). Confirmed origin, network and source provenance are recorded in `evidence/project-status.json`; its development stage remains explicit because public availability is not security certification or proof of a mainnet sale.

The actual public Workers/D1 runtime was exercised using anonymous requests and a fresh unfunded wallet's Ed25519 authentication signature. Recorded checks cover nonce binding, durable session authentication, replay rejection, foreign-origin rejection, invalid inventory rejection and logout. A separate response verified current third-party Raydium account state without a wallet. `evidence/public-runtime.json` records those results and `transactionsSent: 0`. Authentication testing moved no funds and was not a marketplace purchase or browser-extension session.

The public `/build-manifest.json` identifies the repository and source revision supplied to the build, with SHA-256 hashes for implementation files and database migrations. Compare its revision and file hashes with the published repository and build output. A generated manifest is a reproducibility aid, not independent proof that an artifact author, deployment or transaction is trustworthy; a missing revision is not a pinned release.

## What is implemented

Sona now connects a supported Solana wallet, reads its balance and verifies Raydium **CPMM Burn & Earn Fee Keys**, creates authenticated persistent listings, coordinates a buyer request and seller approval, and submits an atomic exchange signed by both wallets. The previous fictional market and browser-local balance/ownership mutations are no longer imported by the active app. The watchlist is the only persisted browser-local market state.

The site keeps its existing layout and styling. The wallet chooser uses Wallet Standard when partial signing is supported, with injected Phantom, Solflare and Backpack fallbacks. Account changes invalidate the authenticated session and pending signatures. Unknown holdings are not treated as Fee Keys because of their names or artwork.

## Architecture and trust boundaries

1. **Authentication:** a server nonce binds the wallet, origin, network and expiry. An exact Ed25519 message signature opens a short-lived session. A message signature does not move funds. Replays, wrong signers and expired challenges are rejected.
2. **Inventory:** the backend reads Solana accounts and checks the current NFT holder, unique legacy SPL mint, canonical Raydium lock PDA, pool and LP mint, canonical LP escrow and pool vault relationships. It uses the current token holder, not the historical lock creator. Public RPC is used without a paid API or indexer.
3. **Listing:** the service stores the authenticated seller, verified mint, exact integer lamport price and expiry. Hosted persistence uses Cloudflare D1; the local reference service uses SQLite. Changes require the seller's session. A fresh ownership check is required around transaction preparation and submission. Listing records and requests are shared through the service, not localStorage.
4. **Seller approval:** a buyer requests the fixed-price sale. The seller signs a short-lived legacy transaction. That signature is specific to the buyer, mint, source account, price, destination, instruction list, fee payer and blockhash. Browser and server compare the canonical message. A released approval cannot be revoked by pretending that a local cancellation invalidates its signature.
5. **Atomic exchange:** one transaction contains only idempotent buyer ATA creation, `TransferChecked` of one Fee Key and a System Program payment of the exact SOL price. The buyer is the fee payer and Fee Key recipient; the seller receives the purchase price. Both sign. Failed instructions roll back the instruction effects together, while network fees may still be charged.
6. **Completion and recovery:** the service records the deterministic transaction signature before submission, waits for finalized confirmation and reconciles uncertain submissions. It keeps durable receipts and does not infer a successful purchase from an RPC timeout. Expiry and released approvals are handled according to chain state.

Assets remain in user wallets until exchange. No new Sona escrow program or deployment funding is required. The existing SPL Token, Associated Token and System programs execute settlement. The order service itself is centralized and must remain available; “non-custodial” does not mean “fully decentralized.” Seller availability is required for each purchase, so this is not an unattended instant-fill order book.

The hosted adapter is in `src/hosted/`: a Workers-compatible HTTP handler, asynchronous marketplace lifecycle and D1 store. The Node implementation remains in `src/server/` as the local reference. They share chain verification and settlement construction, but storage and request execution differ. Node/SQLite test evidence must not be relabeled as proof that the hosted D1 workflow executed successfully. Local workerd/D1 checks and the actual public runtime checks are recorded separately; their authentication/read scope does not establish that a deployed marketplace sale has completed.

## Evidence and what it establishes

| Evidence | What it records | What it does not establish |
|---|---|---|
| `tests/wallet.test.mjs` | Wallet Standard/injected adapters, account switches, message/transaction integrity, exact SOL formatting and actual UI action failure behavior | An independently observed session with a user's installed wallet extension |
| `tests/raydium.test.mjs` and `evidence/raydium-mainnet-read.json` | Decoder checks against real public account bytes, tamper rejection and a read-only mainnet observation with slot/account hashes | A Sona customer, listing, asset under our control, or sale |
| `evidence/settlement-local.json` | Real SPL/ATA/System execution on an isolated validator, exact payment, rollback and rejected signatures/instructions | A mainnet Raydium Fee Key transaction, deployed Sona program or security audit |
| `evidence/backend-local.json` | Actual Node HTTP authentication, persistent listing/request/approval, both transaction signatures, finalized receipt, idempotence and SQLite restart persistence | Workers/D1 execution, public deployment or mainnet trading; the test runner injects authenticity for a purpose-created SPL NFT |
| `evidence/hosted-local.json` | Actual Request/Response HTTP execution through the hosted adapter, fresh marketplace instances per request, D1-compatible SQLite transactions, local-validator settlement and restart recovery | Cloudflare's deployed D1 runtime or a real Raydium Fee Key sale; test authenticity is injected for a purpose-created SPL NFT |
| `evidence/hosted-settlement-local.json` | Actual SPL/ATA/System execution, exact payment, rollback, replay rejection and transaction-integrity cases for the hosted release's settlement source | A public cloud deployment, real Raydium Fee Key transfer or mainnet sale |
| `evidence/workerd-local.json` | Actual local workerd/D1 HTTP configuration, Ed25519 authentication and session/replay/origin checks, plus a current third-party protocol read | A deployed-cloud transaction, marketplace sale or browser-extension session |
| `evidence/public-runtime.json` | Actual public Workers/D1 API availability, origin-bound nonce, Ed25519 authentication, replay/origin rejection, authenticated inventory rejection, logout and a current read-only Raydium observation | A marketplace settlement, mainnet sale, user adoption, wallet-extension session or security audit; zero blockchain transactions were sent |
| `/api/verify/:mint` | A current read of the mint, holder, canonical Raydium lock, pool, LP escrow and vaults; returned network, slot, observation time and signing-flow support | A Sona listing, sale, customer, asset valuation, yield or authority to trade the asset |
| `/api/receipts` | Actual completed transactions from the running marketplace's database | Test receipts or third-party transactions; neither is seeded into this endpoint |
| `scripts/check-readiness.mjs` | Source presence, artifact structure and hashes matching each artifact's listed source files | Independent execution, authenticity of the artifact author, dependency security, public availability or a production release certification |

Counts belong in the generated test output and artifact files, not in a static marketing claim. Execution artifacts include exact source hashes. If implementation or test sources change, the readiness command reports stale evidence until the actual runner is repeated. Manually replacing hashes is not a verification step. A saved mainnet observation is dated evidence, not proof that its holder still owns the asset now.

The mainnet Fee Key in the read-only record belongs to an unrelated third party. It was selected from a public Raydium transaction and is never inserted as marketplace inventory, claimed as a Sona user or counted as Sona volume. Its mint is `GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o`; the recorded holder is a program address that cannot use Sona's ordinary-wallet signing flow. This fixture therefore demonstrates read compatibility only. See [Raydium source provenance](../evidence/RAYDIUM-SOURCES.md) for the exact addresses, official pinned references, account layouts and limits.

The technical page exposes the same public read-only verifier to every visitor. A `GET /api/verify/:mint` discovers the current holder from Solana and performs protocol checks; the client does not supply an asserted owner. An optional `?tokenAccount=<address>` avoids the expensive network-wide holder lookup on free RPC providers. The account is only a lookup hint: the service still reads and validates its SPL mint, amount, current owner and the complete canonical Raydium relationships. It must never trust a client-supplied account as ownership evidence. Anyone may supply their token account from a wallet or explorer; no server-side reference-mint exception exists.

A successful result includes `readOnly: true`, `observedAt`, `signingFlowSupported` and the full account proof. The verifier performs no transaction and does not seed a listing. It may correctly reject an altered or unsupported asset or report a public RPC failure. The reference's ownership may change after any recorded observation. Public RPC providers may deny hosting-provider traffic or rate-limit expensive indexed methods; an HTTP error is not converted into a successful verification.

## Reproduce locally

Requirements: Node.js 24 or later; the local validator integration runner also needs `solana-test-validator`. It discovers standard installation paths or accepts the optional `SOLANA_TEST_VALIDATOR` absolute binary path. All validator keys are ephemeral, and test funds have no value.

For the Node/SQLite reference, from the repository's `marketplace` directory:

```sh
npm ci
npm run build
npm test
npm run test:chain
npm run verify:raydium
npm run readiness
npm start
```

`npm run test:chain` runs actual local validator and HTTP integration execution and writes the local evidence artifacts. `npm run verify:raydium` reads an existing public mainnet account and records its live observation; it does not sign or send transactions. That reference can correctly fail later if the holder or lock state changes. `npm run readiness` is an offline evidence inventory and intentionally exits nonzero while public production readiness remains unverified. Source keywords and declarations cannot turn it green.

From the repository root, `npm ci` installs the hosted application dependencies, `npm run build` builds the Workers application, and `npm run test:hosted` runs the hosted adapter tests. These commands and their exact results should be attached to the released source revision. Unit tests against a D1-compatible test store are not evidence of an independently observed deployed trade. The repository includes an inactive CI template at `docs/ci/verify.yml`; no GitHub Actions execution is claimed.

`npm start` serves the UI and API together at `http://127.0.0.1:4173/app/`. It defaults to the free public Solana mainnet RPC. Startup verifies the cluster’s genesis hash, and the SQLite database is bound to its cluster and genesis identity. Default database files are separated by cluster under `var/marketplace-${cluster}.sqlite`; they are not published as source or evidence. Optional configuration exists for a different port, public HTTPS origin, cluster, database path or RPC endpoint; no paid key is required to run locally. A browser with a supported wallet extension is needed to approve real user actions. An in-app browser without an extension correctly shows that no wallet was detected.

## Costs and limits

Connecting, reading accounts, signing an authentication message and creating a listing require no Sona deposit or paid API key. An actual purchase still requires buyer funds for the asking price, Solana transaction fees and any new token-account rent. This cannot be made zero-cost by removing a custom program. Public RPC can rate-limit, fail or become unavailable; errors are not converted into fabricated positions or successful purchases. Hosted operation is subject to platform quotas, D1 availability and public RPC limits. A free deployment is not a guarantee of unlimited capacity, uptime or an independent security review.

Version 1 transfers the **entire CPMM Fee Key**. It does not support CLMM positions, Token-2022 Fee Key NFTs, splitting or partial rights, LP principal redemption, fee claiming, creating new locks, confidential settlement or arbitrary NFTs. Token-2022 assets inside a supported CPMM pool are distinct from a Token-2022 Fee Key. Discovery is bounded and reports truncation rather than implying a complete scan. Fee income, APR and redemption values are not fabricated.

## Remaining release work

- Recheck the build manifest, source revision and public runtime after future deployments. Continue to record hosted tests separately from the Node/SQLite reference evidence.
- Exercise the full listing, purchase reservation, seller approval and settlement lifecycle on the public runtime with consenting holders of supported Fee Keys. Current public checks cover authentication and reads; complete transaction execution was tested locally.
- Independently observe the real browser-wallet workflow, including rejected prompts, account switching, stale approvals and two consenting parties completing a purchase.
- Record a real supported Fee Key settlement on the intended public network, with the actual receipt and relevant before/after account evidence. Local NFT settlement and mainnet reads do not combine into this claim.
- Obtain an independent review of custody assumptions, authentication, eligibility, transaction construction, lifecycle races, dependencies and service operation. Automated tests are not that review.

No numerical rating is guaranteed. The same implementation and evidence are exposed to every visitor. Token distribution, holder concentration and token-age checks require a separate real mint and are not altered by this application work. No fake users, volume, receipt history, source history or reviewer-specific behavior is used.

The co-signed settlement currently requires ordinary signing wallets. A program-owned or multisig-held Fee Key can pass the read-only Raydium authenticity check, but cannot be listed or sold through this signing flow. The public reference account is used only as read evidence.
