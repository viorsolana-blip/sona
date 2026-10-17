# Sona bigint-buffer compatibility shim

This is an original, locally reviewed, pure-JavaScript implementation of the four `bigint-buffer` conversion exports used by `@solana/buffer-layout-utils`: `toBigIntLE`, `toBigIntBE`, `toBufferLE`, `toBufferBE`. It has no native bindings, external dependencies, lifecycle scripts or network access.

## Why it exists

The legacy dependency path `@solana/spl-token@0.4.14` → `@solana/buffer-layout-utils@0.2.0` → `bigint-buffer@1.1.5` pulls in an unpatched native component. [GHSA-3gc7-fjrx-p6mg / CVE-2025-3194](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) covers `bigint-buffer <= 1.1.5`, with no patched release in the official advisory as inspected on 18 October 2026.

The [Solana maintainer response](https://github.com/solana-program/token-2022/issues/453) explains that `Buffer.from` prevents the reported null-input route through SPL layouts. [Upstream proposed fix #64](https://github.com/no2chem/bigint-buffer/pull/64) also describes a native allocation/width failure, including 33-byte and 257-byte conversion regression cases. That change remains an unmerged proposal, so this project does not represent it as an official fix.

Sona removes that native execution path with a checked-in replacement rather than suppressing the advisory. Root `package.json` must override `bigint-buffer` to `file:./vendor/bigint-buffer`, and `package-lock.json` must resolve that local package. A test checks that the installed implementation exactly matches this file. An npm audit becoming clear after a local replacement is not an independent security audit of the replacement.

## Contract and intentional differences

- Input bytes: Buffer or Uint8Array, zero to 1 MiB. Decoders return unsigned bigint and never mutate the input, including subarrays.
- Encoded values: unsigned bigint only. Width must be an integer from zero to 1 MiB. The value must fit the width exactly; negative numbers and overflow throw. Zero width accepts only zero.
- Correctly handles 8/16/24/32-byte SPL integer layouts and larger non-aligned widths without native allocation code.
- The old library could truncate oversized values; this shim deliberately rejects them. Financial serialization must not silently change amounts.
- It does not promise every undocumented permissive behavior of the original library, compatibility with signed integer schemas, or a third-party audit.

Source SHA-256 (`index.cjs`):

```text
f96789c21fb973e7280c921073d783ca732f1701cdcaaed1b5cb06113056f492
```

After the root dependency override has been installed, run:

```sh
node --test tests/bigint-buffer.test.mjs tests/raydium.test.mjs tests/settlement.test.mjs
npm ls bigint-buffer
npm audit
```

The dedicated tests cover known-endian values, u64 extrema, randomized round trips for all SPL widths, upstream native regression widths, empty inputs, input immutability, malformed inputs, overflow, allocation bounds and use through the installed SPL layout module. Raydium and settlement tests cover downstream account decoding and transaction construction. The public Raydium verification script separately checks the live read path after dependency installation.
