# Verify a real mainnet exchange

This tool reads Solana and the optional public Sona receipts API. It never loads a private key, requests an airdrop, signs, sends a transaction, or asks either participant to transfer funds. The default RPC is the free, keyless `https://solana-rpc.publicnode.com` endpoint.

A real exchange needs an existing, eligible Raydium CPMM Burn & Earn Fee Key, its consenting seller, a distinct consenting buyer, an agreed positive SOL price, and enough buyer SOL for that price plus network fees and any new associated token account rent. Different wallet addresses do not establish different beneficial owners. A controlled transfer must be described as a controlled transfer; it is not evidence of independent demand.

No real mainnet Sona sale is asserted by the existence of this script or its unit tests. The tests use synthetic transactions and modified public account fixtures. A successful read-only Raydium check is also not a sale.

## Before the exchange

From the repository's `marketplace` directory, create a local JSON file containing exactly these five **public** values, replacing every placeholder:

```json
{
  "mint": "PUBLIC_FEE_KEY_MINT",
  "seller": "PUBLIC_SELLER_ADDRESS",
  "buyer": "PUBLIC_BUYER_ADDRESS",
  "sourceTokenAccount": "PUBLIC_SELLER_TOKEN_ACCOUNT",
  "priceLamports": "AGREED_POSITIVE_INTEGER_LAMPORTS"
}
```

One SOL is 1,000,000,000 lamports. Keep the amount as a string to preserve every lamport. Do not put seed phrases, private keys, wallet exports or API secrets in this file; unrelated fields are rejected. The `terms` object from a prior generated report can be reused: its additional `destinationTokenAccount` is accepted only if it exactly matches the independently derived buyer ATA.

```sh
node scripts/verify-mainnet-sale.mjs preflight \
  --terms /absolute/path/public-terms.json \
  --out /absolute/path/mainnet-preflight.json
```

The preflight verifies the mainnet genesis hash, finalized Raydium mint/holder/lock/pool/escrow/vault state, signing wallet addresses, and buyer ATA eligibility. It obtains the fee for the actual canonical message and the current ATA rent requirement, then reports:

- Agreed price, estimated network fee, ATA funding and total estimated buyer debit separately.
- Current buyer balance and any shortfall, as exact integer lamport strings.
- `readyToSettle`, verified slots, the temporary blockhash and source-code hashes.

`verified: true` means the read-only checks completed; it does not mean a transaction happened. If `readyToSettle` is false, the buyer cannot cover the estimate. Even a successful preflight is a dated snapshot: neither the asset nor funds are reserved, and the marketplace must recheck ownership before signing/submission. Existing eligible buyer ATAs incur no new account rent. Mainnet transaction fees cannot be made zero by this tool.

Use the existing Sona wallet flow for any explicitly agreed exchange. Each participant reviews and signs with their own wallet. This verification command is not a settlement command and has no signing capability.

## After finalized settlement

Use the actual transaction signature produced by the exchange:

```sh
node scripts/verify-mainnet-sale.mjs receipt \
  --terms /absolute/path/public-terms.json \
  --signature ACTUAL_PUBLIC_TRANSACTION_SIGNATURE \
  --preflight /absolute/path/mainnet-preflight.json \
  --check-sona \
  --out /absolute/path/mainnet-receipt.json
```

The receipt verifier requires a successful finalized transaction, matching signature-status slot, both cryptographically valid wallet signatures, and the exact three-instruction exchange. It rebuilds the message from the agreed terms and the transaction's observed blockhash, and compares the complete message bytes. It checks one NFT moving from seller to buyer, exact SOL received by the seller, the buyer's complete debit including actual fee and ATA funding, and unchanged unrelated account balances. Missing token metadata, unsafe numeric RPC values, altered amounts, extra instructions and invalid signatures fail closed.

It then verifies that the buyer currently holds the genuine Raydium Fee Key at a finalized slot at least as recent as the transaction. If supplied, the preflight is compared for matching terms, finalized slots strictly earlier than the transaction, and unchanged lock/pool linkage. Record that preflight **before** the sale for before/after lock-continuity evidence. Without it, current Raydium verification does not establish eligibility or lock state at the historical transaction slot. The supplied JSON remains a recorded observation, not an independent or tamper-proof attestation.

Current ownership verification will fail if the buyer has already transferred the Fee Key onward. Run it promptly; the tool does not substitute a historical ownership claim for the requested current-state proof.

`--check-sona` performs a GET against the known public Sona `/api/receipts` endpoint and requires a unique receipt matching the signature, terms, finalized slot and message hash. Without that flag, a matching canonical transaction is **not attributed to Sona**. An optional `--expected-message-sha256 HASH` can additionally pin the message to a separately recorded approval; a supplied hash or editable JSON file is not independently authenticated evidence.

The public receipts response is currently bounded to 50 records. If a valid transaction is outside that returned set, `--check-sona` fails closed; this is an evidence-discovery limit, not proof that the exchange never happened. The chain verification can still run without that flag and will leave Sona attribution unestablished.

Reports include the public addresses, signature, RPC origin, observation time, source hashes and verification scope. They never include credentials. The tool writes `--out` only after every required check succeeds; transient failures preserve an existing report. Inspect the dated scope before publishing a report. Do not relabel a test fixture or an unrelated transaction as a Sona customer sale.

## Limits

The tool trusts the selected RPC provider's account and finalized-chain responses; signatures and transaction shape are checked locally. For additional assurance, repeat the same verification with another reputable mainnet RPC using `SONA_MAINNET_RPC_URL`. The endpoint must use HTTPS; only its origin is recorded. No paid key is required by the default path, and free endpoints may rate-limit or omit historical records.

Supported receipt transactions are legacy SPL Fee Key transfers between ordinary signing wallets using the canonical Sona message. Prefunded, uninitialized ATA addresses and unusual wallet account types are rejected instead of being treated as verified. Public Sona receipt matching establishes correspondence with the marketplace, not an independent security audit, fair pricing, independent counterparties, or organic commercial demand.

Run the offline adversarial checks with:

```sh
node --test tests/verification-mainnet-sale.test.mjs
```
