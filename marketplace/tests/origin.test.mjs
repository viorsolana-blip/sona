import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SONA_ORIGIN, resolveSonaOrigin } from '../src/security/origin.mjs';

test('only the original origin is allowed before a custom origin is configured', () => {
  assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN), DEFAULT_SONA_ORIGIN);
  assert.equal(resolveSonaOrigin('https://sona.example'), null);
  assert.equal(resolveSonaOrigin(undefined), null);
});

test('an explicit custom origin and the original both retain their own authentication origin', () => {
  const configured = 'https://sona.example';
  assert.equal(resolveSonaOrigin(configured, configured), configured);
  assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, configured), DEFAULT_SONA_ORIGIN);
  for (const other of ['https://www.sona.example', 'https://app.sona.example', 'https://sona.example.evil.example',
    'https://evilsona.example', 'http://sona.example', 'https://sona.example:8443', 'https://unrelated.example']) {
    assert.equal(resolveSonaOrigin(other, configured), null, other);
  }
});

test('a malformed configured origin fails closed even on the original host', () => {
  const malformed = ['', null, 1, {}, ['https://sona.example'],
    'sona.example', '//sona.example', 'http://sona.example', 'ftp://sona.example',
    'https://*.sona.example', 'https://sona.example,https://evil.example',
    'https://user@sona.example', 'https://user:password@sona.example',
    'https://sona.example/app', 'https://sona.example/../', 'https://sona.example/%2f',
    'https://sona.example?query', 'https://sona.example?', 'https://sona.example#fragment', 'https://sona.example#',
    'https://sona.example/', 'https://sona.example//', 'https://SONA.example', 'HTTPS://sona.example',
    ' https://sona.example', 'https://sona.example ', 'https://sona.\nexample',
    'https://sona.example:443', 'https://sona.example.', 'https://sona%2eexample',
    'https://-sona.example', 'https://sona-.example', 'https://sona..example', 'https://sona_example',
    'https://' + 'a'.repeat(64) + '.example', 'https://sona.example:65536'];
  for (const value of malformed) {
    assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, value), null, String(value));
    assert.equal(resolveSonaOrigin('https://sona.example', value), null, String(value));
  }
});

test('request origins cannot smuggle paths, credentials, aliases or wildcards into the allowlist', () => {
  const configured = 'https://sona.example';
  for (const request of ['', null, {}, configured + '/', configured + '?', configured + '#',
    configured + '/app/', 'https://user@sona.example', 'https://*.sona.example',
    'https://SONA.example', 'https://sona.example:443', 'https://sona%2eexample',
    ' https://sona.example', 'https://sona.example\n']) {
    assert.equal(resolveSonaOrigin(request, configured), null, String(request));
  }
});

test('local preview must be explicitly configured and use canonical localhost or 127.0.0.1', () => {
  for (const local of ['http://localhost', 'http://localhost:4180', 'http://127.0.0.1', 'http://127.0.0.1:4180']) {
    assert.equal(resolveSonaOrigin(local), null);
    assert.equal(resolveSonaOrigin(local, local), local);
    assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, local), DEFAULT_SONA_ORIGIN);
    assert.equal(resolveSonaOrigin('https://sona.example', local), null);
  }
  for (const localAlias of ['http://localhost.evil.example:4180', 'http://127.1:4180',
    'http://2130706433:4180', 'http://0x7f000001:4180', 'http://127.0.0.2:4180',
    'http://0.0.0.0:4180', 'http://[::1]:4180', 'http://localhost:80', 'http://localhost.:4180']) {
    assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, localAlias), null, localAlias);
    assert.equal(resolveSonaOrigin(localAlias, localAlias), null, localAlias);
  }
});

test('an explicit nondefault HTTPS port is a distinct allowed origin', () => {
  const configured = 'https://sona.example:8443';
  assert.equal(resolveSonaOrigin(configured, configured), configured);
  assert.equal(resolveSonaOrigin('https://sona.example', configured), null);
});

test('registered apex, explicit www alias and original each retain their own authentication origin', () => {
  const canonical = 'https://sonafi.trade', alias = 'https://www.sonafi.trade';
  for (const requested of [DEFAULT_SONA_ORIGIN, canonical, alias]) {
    assert.equal(resolveSonaOrigin(requested, canonical, alias), requested);
  }
  assert.equal(resolveSonaOrigin(alias, canonical), null, 'www must be explicitly configured');
  for (const requested of ['https://app.sonafi.trade', 'https://www.www.sonafi.trade',
    'https://www.sonafi.trade.evil.example', 'http://www.sonafi.trade',
    alias + '/', alias + ':443', alias + '?', alias + '#', 'https://user@www.sonafi.trade']) {
    assert.equal(resolveSonaOrigin(requested, canonical, alias), null, requested);
  }
});

test('invalid or unrelated www configuration fails closed on every previously allowed origin', () => {
  const canonical = 'https://sonafi.trade', expectedAlias = 'https://www.sonafi.trade';
  for (const alias of ['', null, {}, canonical, 'https://evil.example', 'https://app.sonafi.trade',
    'https://www.sonafi.trade.evil.example', 'http://www.sonafi.trade', 'https://*.sonafi.trade',
    expectedAlias + ':8443', expectedAlias + ':443', expectedAlias + '/', expectedAlias + '?query',
    expectedAlias + '#hash', 'https://user@www.sonafi.trade', 'https://WWW.sonafi.trade']) {
    for (const requested of [DEFAULT_SONA_ORIGIN, canonical, expectedAlias]) {
      assert.equal(resolveSonaOrigin(requested, canonical, alias), null, `${requested} with ${String(alias)}`);
    }
  }
});

test('www configuration requires a valid nonlocal HTTPS canonical host without a www prefix', () => {
  const cases = [
    [undefined, 'https://www.sonafi.trade'],
    ['', 'https://www.sonafi.trade'],
    ['https://sonafi.trade/', 'https://www.sonafi.trade'],
    ['http://localhost:4180', 'https://www.localhost:4180'],
    ['http://127.0.0.1:4180', 'https://www.127.0.0.1:4180'],
    ['https://localhost', 'https://www.localhost'],
    ['https://127.0.0.1', 'https://www.127.0.0.1'],
    ['https://www.sonafi.trade', 'https://www.www.sonafi.trade'],
  ];
  for (const [canonical, alias] of cases) {
    assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, canonical, alias), null, String(canonical));
    assert.equal(resolveSonaOrigin(alias, canonical, alias), null, String(canonical));
  }
});

test('www alias must preserve the canonical HTTPS port exactly', () => {
  const canonical = 'https://sonafi.trade:8443', alias = 'https://www.sonafi.trade:8443';
  for (const requested of [DEFAULT_SONA_ORIGIN, canonical, alias]) {
    assert.equal(resolveSonaOrigin(requested, canonical, alias), requested);
  }
  assert.equal(resolveSonaOrigin('https://www.sonafi.trade', canonical, alias), null);
  assert.equal(resolveSonaOrigin(DEFAULT_SONA_ORIGIN, canonical, 'https://www.sonafi.trade'), null);
});
