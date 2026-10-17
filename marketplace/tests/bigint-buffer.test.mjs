import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE } = require('../vendor/bigint-buffer/index.cjs');

test('known unsigned encodings preserve endian order and u64 boundaries', () => {
  assert.equal(toBufferBE(0x1234n, 4).toString('hex'), '00001234');
  assert.equal(toBufferLE(0x1234n, 4).toString('hex'), '34120000');
  assert.equal(toBigIntBE(Buffer.from('00001234', 'hex')), 0x1234n);
  assert.equal(toBigIntLE(Buffer.from('34120000', 'hex')), 0x1234n);
  const maximum = (1n << 64n) - 1n;
  assert.deepEqual(toBufferLE(maximum, 8), Buffer.alloc(8, 255));
  assert.equal(toBigIntLE(Buffer.alloc(8, 255)), maximum);
});

test('round trips all SPL widths and the upstream native-overflow regression widths', () => {
  for (const width of [1, 2, 8, 16, 24, 32, 33, 257, 1024]) {
    for (let iteration = 0; iteration < 8; iteration++) {
      const input = randomBytes(width);
      assert.deepEqual(toBufferLE(toBigIntLE(input), width), input);
      assert.deepEqual(toBufferBE(toBigIntBE(input), width), input);
    }
    assert.equal(toBigIntLE(toBufferLE(3n, width)), 3n);
    assert.equal(toBigIntBE(toBufferBE(3n, width)), 3n);
  }
});

test('zero width and empty input are handled without native calls', () => {
  assert.equal(toBigIntLE(Buffer.alloc(0)), 0n);
  assert.equal(toBigIntBE(new Uint8Array(0)), 0n);
  assert.equal(toBufferLE(0n, 0).length, 0);
  assert.equal(toBufferBE(0n, 0).length, 0);
  assert.throws(() => toBufferLE(1n, 0), RangeError);
});

test('byte decoding never mutates the input or misreads a subarray offset', () => {
  const input = Buffer.from([0, 1, 2, 3, 4]);
  const original = Buffer.from(input);
  assert.equal(toBigIntLE(input.subarray(1, 3)), 0x0201n);
  assert.equal(toBigIntBE(new Uint8Array(input.buffer, input.byteOffset + 1, 2)), 0x0102n);
  assert.deepEqual(input, original);
});

test('bad input and out-of-range serialization fail closed', () => {
  for (const value of [null, undefined, 1, '12', {}, [], new Int16Array([1])]) {
    assert.throws(() => toBigIntLE(value), TypeError);
    assert.throws(() => toBigIntBE(value), TypeError);
  }
  for (const value of [null, undefined, 1, '12', {}]) assert.throws(() => toBufferLE(value, 8), TypeError);
  for (const width of [-1, 0.5, NaN, Infinity, '8', 1024 * 1024 + 1]) assert.throws(() => toBufferBE(0n, width), RangeError);
  for (const value of [-1n, 256n, 2n ** 64n]) assert.throws(() => toBufferLE(value, 1), RangeError);
  assert.throws(() => toBigIntLE(Buffer.alloc(1024 * 1024 + 1)), RangeError);
});

test('installed SPL layouts use the safe implementation and preserve layout semantics', () => {
  // Root package override must make this true; otherwise native vulnerable code remains active.
  const installed = require('bigint-buffer');
  assert.equal(readFileSync(require.resolve('bigint-buffer'), 'utf8'), readFileSync(new URL('../vendor/bigint-buffer/index.cjs', import.meta.url), 'utf8'));
  assert.equal(require('bigint-buffer/package.json').name, '@sona/bigint-buffer-safe');
  assert.throws(() => installed.toBigIntLE(null), TypeError);
  const { u64, u128, u192, u256 } = require('@solana/buffer-layout-utils');
  for (const [width, makeLayout] of [[8, u64], [16, u128], [24, u192], [32, u256]]) {
    const layout = makeLayout();
    const maximum = (1n << BigInt(width * 8)) - 1n;
    const destination = Buffer.alloc(width + 4);
    assert.equal(layout.encode(maximum, destination, 2), width);
    assert.equal(layout.decode(destination, 2), maximum);
    assert.throws(() => layout.encode(maximum + 1n, destination, 2), RangeError);
  }
});
