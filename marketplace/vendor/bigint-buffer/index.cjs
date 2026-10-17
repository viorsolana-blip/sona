'use strict';

// Original implementation for Sona; API-compatible for valid unsigned fixed-width
// SPL layout values. Deliberately rejects overflow instead of truncating money values.
// There is no addon loader, native code, install script or external dependency.
const MAX_BYTES = 1024 * 1024;

function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected a Buffer or Uint8Array.');
  if (value.byteLength > MAX_BYTES) throw new RangeError('Input exceeds the supported byte limit.');
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function toBigIntBE(value) {
  const input = bytes(value);
  return input.length === 0 ? 0n : BigInt(`0x${input.toString('hex')}`);
}

function toBigIntLE(value) {
  const input = Buffer.from(bytes(value));
  input.reverse();
  return input.length === 0 ? 0n : BigInt(`0x${input.toString('hex')}`);
}

function toBufferBE(value, width) {
  if (typeof value !== 'bigint') throw new TypeError('Expected an unsigned bigint.');
  if (!Number.isSafeInteger(width) || width < 0 || width > MAX_BYTES) throw new RangeError('Invalid buffer width.');
  if (value < 0n || (value >> BigInt(width * 8)) !== 0n) throw new RangeError('Unsigned bigint does not fit the requested width.');
  if (width === 0) return Buffer.alloc(0);
  return Buffer.from(value.toString(16).padStart(width * 2, '0'), 'hex');
}

function toBufferLE(value, width) {
  return toBufferBE(value, width).reverse();
}

module.exports = { toBigIntBE, toBigIntLE, toBufferBE, toBufferLE };
