// SCENARIO: bearer authorization with the per-address failure limiter.
// EXPECTS: public health path needs no token; wrong/missing tokens are refused;
// the right token passes and clears failures; twenty failures lock the address.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Authorizer, extractBearer, isPublicPath } from '../src/auth.ts';

const TOKEN = 'unit-test-token-0123456789abcdef';

test('health is public, everything else under /api needs the header', () => {
  assert.equal(isPublicPath('/api/v1/health'), true);
  assert.equal(isPublicPath('/api/v1/overview'), false);
  const auth = new Authorizer(TOKEN);
  assert.equal(auth.authorize('/api/v1/health', undefined, '10.0.0.1').kind, 'ok');
  assert.equal(auth.authorize('/api/v1/overview', undefined, '10.0.0.1').kind, 'unauthorized');
});

test('extractBearer accepts the scheme case-insensitively and rejects other schemes', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc');
  assert.equal(extractBearer('bearer abc'), 'abc');
  assert.equal(extractBearer('Basic abc'), null);
  assert.equal(extractBearer(undefined), null);
});

test('the right token is accepted and a wrong one refused', () => {
  const auth = new Authorizer(TOKEN);
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.2').kind, 'ok');
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}x`, '10.0.0.2').kind, 'unauthorized');
  assert.equal(auth.authorize('/api/v1/overview', 'Bearer short', '10.0.0.2').kind, 'unauthorized');
});

test('twenty failures inside the window lock the address until the window passes', () => {
  let clock = 1_000_000;
  const auth = new Authorizer(TOKEN, { maxFailures: 3, windowMs: 60_000, now: () => clock });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(auth.authorize('/api/v1/overview', 'Bearer wrong', '10.0.0.3').kind, 'unauthorized');
  }
  const locked = auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.3');
  assert.equal(locked.kind, 'rate_limited');
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.4').kind, 'ok', 'another address is unaffected');
  clock += 61_000;
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.3').kind, 'ok');
});
