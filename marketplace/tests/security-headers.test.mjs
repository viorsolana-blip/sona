import test from 'node:test';
import assert from 'node:assert/strict';
import { protectResponse } from '../src/security/response-headers.mjs';

test('dapp and technical documents cannot be framed and preserve exact content', async () => {
  for (const pathname of ['/app/', '/app/index.html', '/technical/', '/setup/', '/setup/index.html', '/api/config']) {
    const response = protectResponse(new Response('<p>Existing interface</p>', {headers:{'Content-Type':'text/html','Cache-Control':'no-store'}}), pathname);
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
    assert.equal(response.headers.get('Content-Security-Policy'), "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '<p>Existing interface</p>');
  }
});

test('security headers preserve cache validators and error status without applying app policy to landing assets', async () => {
  const response=protectResponse(new Response(null,{status:304,headers:{ETag:'"known"'}}), '/assets/example.svg');
  assert.equal(response.status,304);
  assert.equal(response.headers.get('ETag'),'"known"');
  assert.equal(response.headers.get('Content-Security-Policy'),null);
  assert.equal(response.headers.get('Referrer-Policy'),'same-origin');
});

test('a stricter upstream CSP remains enforced alongside the baseline', () => {
  const response=protectResponse(new Response('existing',{headers:{'Content-Security-Policy':"default-src 'none'; script-src 'none'"}}), '/app/');
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; script-src 'none', frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
});
