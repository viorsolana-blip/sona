# Raydium CPMM Fee Key verification

Recorded 18 October 2026 (Australia/Adelaide). This module reads public Solana accounts. It does not sign, send, sell, create locks, withdraw liquidity, or collect fees.

## What was actually verified

`src/chain/raydium.mjs` successfully verified an existing mainnet Raydium CPMM Fee Key against `https://api.mainnet-beta.solana.com`, with no API key, at **finalized slot 458138474**. The actual base64 account snapshot at finalized slot **458138200** is embedded in `tests/raydium.test.mjs`. Tests mutate copies of those genuine bytes to exercise rejection paths.

| Account | Address |
|---|---|
| Fee Key mint | `GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o` |
| Current holder when read | `AKesWP7KUE9QSnZuU35yQE8HcWQbTsRGMKAbaqESHVrx` |
| Holder token account | `6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7` |
| Canonical locked liquidity account | `GAHVFUQAVEKgwvcZbU3verA5QPPk4jBvGdaZuhqgJLXU` |
| CPMM pool | `4FBWLAbYs6TXSnbsGCyUNsu2gq3CWCHVo5ujYBKvfmG6` |
| LP mint | `5p9cyBAx9wZcZ9CeKhttiRKwykuvLioY1ut4zbPCWvHo` |
| Raydium LP escrow ATA | `A3Hdukkh1BWeoVo5d5CVPLf13LiA2xUzaFgb46VcQZvY` |
| Pool vault A | `6JofGPUezDC2KAu2VRY7NQSrWTRkfVZnTWqupSztMxLx` |
| Pool vault B | `CNwj1xzUuAitiPSXqq3HMRE5ySDTMdn1D2JNtVjjZYUU` |

The position was located from [this successful public Raydium fee collection transaction](https://explorer.solana.com/tx/AAHxBXqDGg8HnsBdjSoUgEjs288PYNcJtD9U7ASHuquBqaAFVHrNfbokVviApUp1LHLS8JC5UMDJA2P2ZAQtfPo), slot 458136940. It is **someone else's transaction and asset**, not a Sona sale, test wallet, listing, endorsement, user, or claimed revenue. Public reads of it prove decoder and integration compatibility only. It must not be seeded into the marketplace as an available listing.

Observed result: `verified: true`, unique legacy SPL mint, decimals `0`, supply `1`, revoked mint/freeze authorities, current holder token amount `1`, locked LP amount `863268213040` in base units, LP decimals `9`. The current holder differed from the historical `locked_owner`, confirming why the latter cannot be used as the current ownership test. One underlying pool token uses Token-2022; this does not turn the Fee Key into a Token-2022 NFT.

Live verification account-data SHA-256 hashes at slot 458138474:

| Account | Bytes | SHA-256 |
|---|---:|---|
| Fee Key mint | 82 | `4f5b0464389b0ee155b98f1871eaf9787a77dd00c72432de8c52a9e6bb3f734b` |
| Holder token account | 165 | `f51a56f995755cf2c29309352343a03fa2b84a60396d3eb990e6ed807549185b` |
| Lock account | 256 | `677a4fe84b384e8cf34580ddc64e517cfca3a2280c82f58aba2af8a6d9e33cb2` |
| CPMM pool | 637 | `c72cf014432e08dd1564ab96a65afd4afbdc51c31b46dae7a5bb31014c84f945` |
| LP mint | 82 | `18415671ae5c67e63cab5e896e814b69d92dfc8b4c9b83c6f797317e48be3208` |
| LP escrow | 165 | `efa2888bfb22a0a8f380764d44bbb5cb73b7e915c6117894ac88d777a72457c0` |
| Pool vault A | 165 | `f14d7aa743abad2e2607f6e2a9ebbe271ed7b01e35cf26477a8ab0a61f7ca17b` |
| Pool vault B | 165 | `e91e23f63374e8f602dd93c7941473b5df6c3b4090750a5f67c66029e969b640` |

## Primary source provenance

Only Raydium-maintained repositories were used as implementation authorities:

- Official SDK commit **`e2e8bcd865189c994682a9477ec8eaf1e2da8aaf`**:
  - [`src/common/programId.ts`](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/common/programId.ts): mainnet/devnet program IDs and authorities.
  - [`src/raydium/cpmm/pda.ts`](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/raydium/cpmm/pda.ts): `locked_liquidity`, `pool_lp_mint`, `pool_vault` seeds.
  - [`src/raydium/cpmm/layout.ts`](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/raydium/cpmm/layout.ts): 637-byte CPMM pool layout.
  - [`src/raydium/cpmm/instruction.ts`](https://github.com/raydium-io/raydium-sdk-V2/blob/e2e8bcd865189c994682a9477ec8eaf1e2da8aaf/src/raydium/cpmm/instruction.ts): legacy SPL Fee Key mint/token account and LP escrow usage.
- Official CPI interface commit **`115df2779d53bacc7db9d0be2773a4b48a6d372b`**:
  - [`programs/locking-cpi/src/states.rs`](https://github.com/raydium-io/raydium-cpi/blob/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/locking-cpi/src/states.rs): `LockedCpLiquidityState` field order and 256-byte length.
  - [`programs/locking-cpi/src/context.rs`](https://github.com/raydium-io/raydium-cpi/blob/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/locking-cpi/src/context.rs): canonical lock PDA, Fee Key holder and amount constraints, LP escrow authority.
  - [`programs/locking-cpi/src/lib.rs`](https://github.com/raydium-io/raydium-cpi/blob/115df2779d53bacc7db9d0be2773a4b48a6d372b/programs/locking-cpi/src/lib.rs): cluster program addresses and `lock_cp_authority_seed`.
- Official documentation: [Burn & Earn](https://github.com/raydium-io/raydium-docs-v1/blob/main/user-flows/burn-and-earn.mdx), [program addresses and source availability](https://github.com/raydium-io/raydium-docs-v1/blob/main/reference/program-addresses.mdx).

The official `raydium-idl` repository was inspected at commit `e7e0c96fe77bcf6a020b84a44c47a722aac8e359`; it contained CPMM, CLMM and LaunchLab IDLs, but **no locking IDL**. The CPI account definitions and public account bytes were therefore used together. The CPI interface contains stub instruction bodies; it is not the deployed locking implementation or a source-verification claim. The full Burn & Earn implementation is not publicly available in Raydium's listed source repositories.

## Exact account layout used

The Anchor discriminator is the first eight bytes of SHA-256(`account:LockedCpLiquidityState`): `19 0a ee c5 cf ea 49 16`. The pool discriminator is SHA-256(`account:PoolState`)[:8]: `f7 ed e3 f5 d7 c3 de 46`.

| Lock field | Offset | Bytes |
|---|---:|---:|
| Discriminator | 0 | 8 |
| locked_lp_amount | 8 | 8 |
| claimed_lp_amount | 16 | 8 |
| unclaimed_lp_amount | 24 | 8 |
| last_lp | 32 | 8 |
| last_k | 40 | 16 |
| recent_epoch | 56 | 8 |
| pool_id | 64 | 32 |
| fee_nft_mint | 96 | 32 |
| historical locked_owner | 128 | 32 |
| locked_lp_mint | 160 | 32 |
| Reserved padding | 192 | 64 |

All integers are unsigned little-endian and decoded as bigint. JSON values are decimal strings; financial base-unit values never pass through floating-point conversion.

## Eligibility policy and limits

1. Canonical PDA from `["locked_liquidity", feeKeyMint]`, owned by the pinned cluster's Raydium lock program, exact length/discriminator, matching Fee Key mint and positive locked LP amount.
2. Matching authenticated CPMM pool and LP mint; canonical LP PDA, valid LP mint authority, initialized SPL LP mint and decimals, positive supply.
3. Canonical Raydium authority LP escrow ATA holds at least this lock's recorded LP amount. The escrow may aggregate multiple locks, so an exact balance equality is not required.
4. Current owner holds exactly one unique, zero-decimal, initialized legacy SPL NFT with revoked mint/freeze authorities, unfrozen token account and no outstanding delegate. These are conservative marketplace eligibility requirements, not a claim that every historical Raydium object is supported.
5. Both canonical pool vaults match the pool mints, recognized legacy/Token-2022 token programs and the CPMM authority.
6. Final eligibility reads all eight accounts in one confirmed/finalized RPC context, after preliminary reads locate the relationships. Evidence includes the slot, addresses, program owners, byte lengths and content hashes. Settlement must still revalidate immediately before building/signing; chain state can change afterward.

No metadata URL, asset image, symbol, token name, API marketing field or wallet label is an authenticity signal. No third-party API, indexer or DAS service is required. Fees, APR, USD value, revenue forecasts, protocol audit status and future yield are not inferred from these account checks.

Version 1 is **CPMM Fee Key secondary transfer only**. It does not support CLMM locks, LP redemption, fee claiming, partial rights, splitting, newly locking liquidity or Token-2022 Fee Key NFTs. Public RPC can throttle or fail. RPC failures are propagated; they are never silently shown as an empty wallet. Discovery scans at most 200 one-unit legacy SPL holdings by default and returns explicit candidate totals and `truncated` if this bound is exceeded.

Mainnet and devnet IDs are pinned from official sources. Mainnet proof is real; devnet address derivation is tested, but this document does not claim a real devnet Raydium Fee Key fixture or a Sona settlement transaction.

## Reproduce

From `sona-site`:

```sh
node --test tests/raydium.test.mjs
node scripts/verify-raydium-live.mjs
```

The reusable live runner verifies the full Solana mainnet genesis hash before checking accounts, prints the result, and atomically writes `evidence/raydium-mainnet-read.json`. `--no-write` prints without changing the cached artifact. It records source hashes so a later source change is visible. A failed live check exits nonzero and preserves the prior dated artifact; a saved artifact is never proof of present ownership. It uses the public endpoint by default; optional `SONA_MAINNET_RPC_URL` can supply a different HTTPS mainnet RPC without storing its credentials or query string in the report.

For a fresh read, run this only while the stated owner still holds that public asset. A later ownership change or exhausted lock can correctly cause rejection.

```js
import { Connection } from '@solana/web3.js';
import { verifyFeeKey } from './src/chain/raydium.mjs';
const result = await verifyFeeKey({
  connection: new Connection('https://api.mainnet-beta.solana.com', 'finalized'),
  cluster: 'mainnet-beta',
  mint: 'GVXkdXXtZRF9ZW81D6amGu5nLEw8FJA4XSD8sGdSnC8o',
  owner: 'AKesWP7KUE9QSnZuU35yQE8HcWQbTsRGMKAbaqESHVrx',
  tokenAccount: '6i9ctDoxQXSwTNUqGrfXfTj9USr5doKKjvu3wZv5DMS7',
  commitment: 'finalized',
});
console.log(JSON.stringify(result, null, 2));
```

This is evidence of a working read-only protocol integration and adversarial validation tests. A public deployment, successful Sona settlement with consenting test wallets, wallet UI verification and independent review require separate evidence.
