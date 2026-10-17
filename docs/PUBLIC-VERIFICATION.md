# Public verification

This guide maps product claims to inspectable behavior. It does not attempt to predict or guarantee a third-party score. Review the commit, runtime response and recorded execution reports together; each proves a different thing. The included CI template is inactive and provides no GitHub Actions run evidence.

## Inspect without a wallet

The public deployment address is `https://sona-liquidity-marketplace.official-alexslobodi.chatgpt.site`. Start with these read-only resources:

| Resource | What to inspect |
| --- | --- |
| `/` and `/app/` | Existing website and marketplace interface; empty inventory is legitimate when no holder has listed. |
| `/technical/` | Implementation scope, evidence links and limitations. |
| `/api/config` | The running network, settlement mode and available configuration. Compare it with the source rather than assuming static copy establishes runtime behavior. |
| `/api/listings` | Current stored listings. An empty array must not be replaced with invented activity. |
| `/api/receipts` | Receipts returned by the running marketplace. Local-validator fixtures and unrelated third-party transactions must not be presented as customer sales. |
| `/build-manifest.json` | Published GitHub revision and SHA-256 hashes of implementation files. |
| `/source/evidence/public-runtime.json` | Recorded anonymous public checks of actual Workers/D1 authentication, replay/origin rejection, logout and live Raydium account reads. |

The technical page includes a wallet-free verifier for any supplied Fee Key mint and optional holder token account. Its public reference is a third-party, program-held asset used only for protocol reads; it is not a Sona listing or sale.

A successful HTTP response proves reachability at that time, not long-term availability, safe settlement or wallet ownership. Review authenticated endpoints in source; a missing-wallet or unauthorized response is expected for an unauthenticated inspection. Public RPC errors should be visible, not replaced by fictional balances or positions.

The [repository](https://github.com/viorsolana-blip/sona) and its [CI template](https://github.com/viorsolana-blip/sona/blob/main/docs/ci/verify.yml) are separate from the live deployment. A repository commit should be matched to any recorded deployment revision before claiming the served source has been verified. The publishing credential lacks workflow permission, so the template is stored under `docs/ci/` and does not run automatically.

## Reproduce the Node implementation

Requires Node.js 24 or later:

```sh
git clone https://github.com/viorsolana-blip/sona.git
cd sona/marketplace
npm ci
npm run build
npm test
```

The tests exercise wallet handling, canonical transaction validation, Raydium account validation and marketplace state transitions. Inspect their fixture setup as well as their assertions. Unit tests do not require wallet funds or a paid API key.

The ordinary test suite does not start a Solana validator. Its conditional validator test is skipped unless explicitly enabled. A green unit-test run must not be described as a mainnet integration run.

## Reproduce actual local chain execution

The recorded local execution used **Solana CLI/test-validator 1.18.20**. Obtain the corresponding platform release from the [official release](https://github.com/solana-labs/solana/releases/tag/v1.18.20), review its provenance, and install `solana-test-validator` on your own test machine. This repository deliberately does not execute an unauthenticated `curl | sh` installer or silently download an unverified validator binary in CI.

With that validator available on `PATH`:

```sh
solana-test-validator --version
npm run test:chain
```

The script creates an isolated ledger and fresh test keys, runs token and SOL transfers through the validator, records signatures/results and cleans up. It does not read an existing wallet key or use mainnet funds. The generated NFT is a purpose-created settlement test asset, not a genuine Raydium Fee Key. These tests isolate the atomic transfer/payment and backend workflow; the separate Raydium checks establish which real assets qualify for that workflow.

Read `evidence/backend-local.json` and `evidence/settlement-local.json` for the exact executed cases and bound source hashes. Re-running the scripts updates those local reports; compare them with the checked-in report before drawing conclusions.

## Reproduce the Raydium mainnet read

```sh
npm run verify:raydium
```

This uses public Solana RPC to validate a public third-party CPMM Fee Key and its connected accounts. No API key, ownership or signing authority is supplied. The read may fail if the free endpoint is unavailable or throttles; that outcome is not a successful verification.

Inspect `evidence/raydium-mainnet-read.json` and `evidence/RAYDIUM-SOURCES.md`. The reference account is not a marketplace listing or a customer. Its existence proves neither that Sona controls it nor that Sona has sold it.

## Inspect the hosted Worker/D1 implementation separately

The public root application runs in a Worker with D1 persistence. The standalone server in `marketplace/` uses Node's SQLite interface. Both may share validation and settlement code, but their request handling, transaction boundaries, persistence and concurrency behavior require separate verification.

A root `npm run build` proves the hosted source compiles. It does not prove that the deployment is reachable or that D1 state persists. Check the deployed API and any hosted test/report supplied with the exact commit. Before treating a hosted sale as verified, establish all of the following from actual observations:

1. Wallet authentication verifies the expected signed challenge and rejects reuse, expiry and changed origins.
2. A listed Fee Key is validated against the canonical Raydium accounts and its current holder.
3. A fresh request from another wallet creates the expected purchase state without transferring funds.
4. The seller signature binds the approved NFT, price and parties; unexpected instructions or modified terms are rejected.
5. The buyer signs the same canonical transaction, and the network confirms the complete NFT/SOL exchange.
6. A durable receipt points to that actual signature and network. Reloading the application preserves the result, and competing requests cannot manufacture a second sale.

These steps require actual wallet holders for a mainnet sale. They are acceptance criteria, not a statement that such a sale has already occurred. Do not manufacture activity to fill this gap.

## Build reproduction and inactive CI template

From the repository root:

```sh
npm ci
npm --prefix marketplace ci
npm --prefix marketplace run build
npm run build
```

The [inactive template](ci/verify.yml) specifies standard Ubuntu GitHub-hosted runners, Node 24, read-only repository permissions, pinned action commits and checked-in lockfiles. It requires no repository secret or paid API key and performs no deployment or financial transaction. The root build uses repository-local tools in a portable execution profile; it does not rely on a local plugin installation.

The template defines two jobs: marketplace tests/wallet build and hosted application compilation. Local tests and builds have passed, but this repository currently has no active verification workflow or GitHub Actions result. Local-validator execution, wallet-extension interaction, a mainnet purchase, independent security review and deployed Worker/D1 integration are outside those proposed jobs unless a separate report explicitly demonstrates them.

## Claims that the evidence does not establish

- An independent audit, formal verification, guaranteed security or a guaranteed third-party score.
- A custom Sona on-chain protocol, autonomous decentralized order book or confidential settlement.
- Supported CLMM positions, principal redemption, fee claiming, partial rights or new Raydium locks.
- Customer volume, completed mainnet trades, adoption or partnerships without independent receipts.

Sona's defensible claim is the narrower implemented workflow: validated Raydium CPMM Fee Keys, wallet-authenticated listings, seller-approved purchases and a canonical bilateral SPL Token/SOL exchange. The evidence should grow when those actions are actually observed, with the original scope and failures retained.
