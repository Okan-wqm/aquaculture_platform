// SCENARIO: bearer authentication resolving to ONE principal, with the per-address failure limiter.
// EXPECTS: the public health path needs no token; wrong/missing tokens are refused;
// a token resolves to its principal (shared token → the operator token holder,
// a principals-file token → that person); twenty failures lock the address.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Authorizer, combineResolvers, extractBearer, isPublicPath, sharedTokenResolver } from '../src/auth.ts';
import type { Principal } from '../src/principal.ts';

const TOKEN = 'unit-test-token-0123456789abcdef';
const KARI: Principal = { id: 'kari', displayName: 'Advokat Kari Nordmann', role: 'lawyer', cases: ['sak-24-001'] };

test('health is public, everything else under /api needs the header', () => {
  assert.equal(isPublicPath('/api/v1/health'), true);
  assert.equal(isPublicPath('/api/v1/overview'), false);
  const auth = new Authorizer(sharedTokenResolver(TOKEN));
  assert.equal(auth.authorize('/api/v1/health', undefined, '10.0.0.1').kind, 'public');
  assert.equal(auth.authorize('/api/v1/overview', undefined, '10.0.0.1').kind, 'unauthorized');
});

test('extractBearer accepts the scheme case-insensitively and rejects other schemes', () => {
  assert.equal(extractBearer('Bearer abc'), 'abc');
  assert.equal(extractBearer('bearer abc'), 'abc');
  assert.equal(extractBearer('Basic abc'), null);
  assert.equal(extractBearer(undefined), null);
});

test('the shared token resolves to the operator token holder; a wrong one to nobody', () => {
  const auth = new Authorizer(sharedTokenResolver(TOKEN));
  const ok = auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.2');
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.kind === 'ok' ? ok.principal.id : null, 'console-token-holder');
  assert.equal(ok.kind === 'ok' ? ok.principal.role : null, 'operator');
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}x`, '10.0.0.2').kind, 'unauthorized');
  assert.equal(auth.authorize('/api/v1/overview', 'Bearer short', '10.0.0.2').kind, 'unauthorized');
});

test("a principals-file token resolves to that person, and the resolvers combine without leaking which one matched", () => {
  const byFile = (token: string): Principal | null => (token === 'kari-token-0123456789abcdefghij' ? KARI : null);
  const auth = new Authorizer(combineResolvers([byFile, sharedTokenResolver(TOKEN)]));
  const lawyer = auth.authorize('/api/v1/me', 'Bearer kari-token-0123456789abcdefghij', '10.0.0.5');
  assert.equal(lawyer.kind, 'ok');
  assert.deepEqual(lawyer.kind === 'ok' ? lawyer.principal : null, KARI);
  const operator = auth.authorize('/api/v1/me', `Bearer ${TOKEN}`, '10.0.0.5');
  assert.equal(operator.kind === 'ok' ? operator.principal.id : null, 'console-token-holder');
  assert.equal(auth.authorize('/api/v1/me', 'Bearer nobody-0123456789abcdefghijklmn', '10.0.0.5').kind, 'unauthorized');
});

test('twenty failures inside the window lock the address until the window passes', () => {
  let clock = 1_000_000;
  const auth = new Authorizer(sharedTokenResolver(TOKEN), { maxFailures: 3, windowMs: 60_000, now: () => clock });
  for (let index = 0; index < 3; index += 1) {
    assert.equal(auth.authorize('/api/v1/overview', 'Bearer wrong', '10.0.0.3').kind, 'unauthorized');
  }
  const locked = auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.3');
  assert.equal(locked.kind, 'rate_limited');
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.4').kind, 'ok', 'another address is unaffected');
  clock += 61_000;
  assert.equal(auth.authorize('/api/v1/overview', `Bearer ${TOKEN}`, '10.0.0.3').kind, 'ok');
});
