// SCENARIO: route compilation, matching and query clamping.
// EXPECTS: `:params` decode, unknown paths return null, a known path with the
// wrong method returns method_not_allowed, limits are clamped and validated.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError } from '../src/errors.ts';
import { clampLimit, compileRoute, matchRoute } from '../src/router.ts';

const noop = async (): Promise<void> => undefined;
const routes = [
  compileRoute({ method: 'GET', pattern: '/api/v1/cycles', handler: noop }),
  compileRoute({ method: 'GET', pattern: '/api/v1/cycles/:cycleId', handler: noop }),
  compileRoute({ method: 'GET', pattern: '/api/v1/legal/cases/:caseId/documents/:documentId', handler: noop }),
];

test('matches exact and parameterised paths, decoding params', () => {
  const plain = matchRoute(routes, 'GET', '/api/v1/cycles');
  assert.ok(plain !== null && plain !== 'method_not_allowed');
  assert.deepEqual(plain.params, {});
  const nested = matchRoute(routes, 'GET', '/api/v1/legal/cases/case_x/documents/doc%3A1');
  assert.ok(nested !== null && nested !== 'method_not_allowed');
  assert.deepEqual(nested.params, { caseId: 'case_x', documentId: 'doc:1' });
});

test('unknown paths are null and wrong methods are method_not_allowed', () => {
  assert.equal(matchRoute(routes, 'GET', '/api/v1/nothing'), null);
  assert.equal(matchRoute(routes, 'POST', '/api/v1/cycles'), 'method_not_allowed');
  assert.equal(matchRoute(routes, 'GET', '/api/v1/cycles/a/b'), null, 'a param never spans a slash');
});

test('clampLimit falls back, caps and rejects garbage', () => {
  assert.equal(clampLimit(new URLSearchParams(''), 100, 1000), 100);
  assert.equal(clampLimit(new URLSearchParams('limit=5000'), 100, 1000), 1000);
  assert.equal(clampLimit(new URLSearchParams('limit=7'), 100, 1000), 7);
  assert.throws(() => clampLimit(new URLSearchParams('limit=abc'), 100, 1000), HttpError);
  assert.throws(() => clampLimit(new URLSearchParams('limit=0'), 100, 1000), HttpError);
});
