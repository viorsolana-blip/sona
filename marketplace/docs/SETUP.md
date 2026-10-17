# Controlled mainnet setup

The public `/setup/` companion checks public wallet addresses, Raydium CPMM state and current rent. It does not create wallets, collect private keys, build a deposit/lock transaction, sign or broadcast. The existing marketplace UI is unchanged.

1. Connect an existing Solana wallet and explicitly capture the seller address, then switch accounts and capture a distinct buyer. Public addresses can also be pasted; that is not proof of ownership. The companion stores valid public fields in tab-scoped session storage and does not authenticate either participant.
2. Find an existing supported CPMM Fee Key, or use Raydium to add a small balanced deposit to the suggested existing SOL/USDC CPMM pool. Burn & Earn permanently locks principal and creates the transferable Fee Key. Raydium constructs those transactions and the user reviews/signs them in their wallet. No universal minimum deposit or all-in creation cost is asserted.
3. Run the cost check. Without a key, this returns verified pool links, actual balances and known/conditional account rents; deposit amounts, transaction fees and optional metadata/protocol charges remain unquoted. With a key, it runs the existing full finalized mainnet preflight for the actual seller, buyer, mint and price. A supported key from another CPMM pool can skip creation.
4. Save the returned preflight **before** the sale. Open the marketplace, authenticate each wallet separately, list, request, seller-approve and buyer-complete. Wallet owners perform all signatures. Save the final transaction signature and run the [mainnet receipt verifier](MAINNET-VERIFICATION.md).

Two wallets controlled by one operator produce a **controlled mainnet settlement test**, not independent customer activity. A cost check is not a receipt or proof of a completed sale. The returned wallet snapshot and preflight have explicit individual finalized slots; they are not an atomic snapshot or a guarantee of future execution.

## API and bounds

`POST /api/setup/quote`, same origin, JSON:

```json
{"seller":"<public address>","buyer":"<different public address>","feeKeyMint":"<optional mint>","priceLamports":"1000"}
```

When the mint is present, an exact positive integer price is required. Only these four keys are accepted. The client cannot choose an RPC, network or suggested pool. The route inherits host/origin checks, a 16 KiB streamed body limit and the persisted general IP rate limit, plus a separate limit of six cost checks per IP per minute. Rate-limit bookkeeping can update D1; no order, authentication or blockchain state is changed by the cost check.

The no-key route authenticates the pinned pool `47hq28mcL7q5GhBg7epyGF2dnuJd4MKFt8QhT7CzYUp4`, standard SPL token programs, SOL/USDC mints, derived vaults and LP mint/escrow. Native balances and canonical seller token-account amounts are exact decimal strings. It does not aggregate every token account or guarantee the pool currently accepts deposits. The existing-key route discovers a bounded seller holder account and invokes the existing Fee Key verifier and canonical settlement preflight.

The hosted setup quote shares the marketplace's free public RPC and respects an existing server-side `SONA_RPC_URL` override. Pool state and wallet state use separate bounded finalized reads, with the wallet read required to be at least as recent as the pool read. Each snapshot has its own recorded slot; the combined result is not atomic. Free endpoints can rate-limit or fail; the page fails closed and never replaces a failed read with a zero balance or an assumed successful transaction.

## Primary references

- [Raydium Burn & Earn](https://docs.raydium.io/user-flows/burn-and-earn) — permanent lock and transferable Fee Key.
- [Add/remove liquidity](https://docs.raydium.io/user-flows/add-remove-liquidity) — deposit flow.
- [Official frontend route source](https://github.com/raydium-io/raydium-ui-v3-public/blob/045a2a942711440b85e091ac313378a1e534f102/src/features/Liquidity/Increase/index.tsx) — `/liquidity/increase/?mode=add&pool_id=…`. The public source is older than the deployed Raydium UI; the companion does not claim to have signed through the current UI.
- [Official lock page source](https://github.com/raydium-io/raydium-ui-v3-public/blob/045a2a942711440b85e091ac313378a1e534f102/src/pages/liquidity/lock.tsx) — `/liquidity/lock/`; select the actual LP holding in Raydium.

This addition does not replace the dated security review or turn its local tests into mainnet sale evidence. Reports bind their own source hashes and execution scopes.
