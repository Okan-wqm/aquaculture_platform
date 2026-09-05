// SCENARIO: what the console's stdout may carry about a client.
// EXPECTS: a case id and a document id are masked out of a logged path; every
// other path is untouched; the authorization header is redacted.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { maskLegalPath, redactHeaders } from '../src/log.ts';

test('a case id and a document id are masked out of a logged legal path', () => {
  assert.equal(maskLegalPath('/api/v1/legal/cases/sak-24-001'), '/api/v1/legal/cases/[case]');
  assert.equal(maskLegalPath('/api/v1/legal/cases/sak-24-001/documents/doc_0123456789abcdef'), '/api/v1/legal/cases/[case]/documents/[document]');
  assert.equal(maskLegalPath('/api/v1/legal/cases/sak-24-001/intake'), '/api/v1/legal/cases/[case]/intake');
  assert.equal(maskLegalPath('/api/v1/legal/cases/sak-24-001/documents'), '/api/v1/legal/cases/[case]/documents');
});

test('paths that name no client are logged as they are', () => {
  assert.equal(maskLegalPath('/api/v1/legal/cases'), '/api/v1/legal/cases');
  assert.equal(maskLegalPath('/api/v1/health'), '/api/v1/health');
  assert.equal(maskLegalPath('/api/v1/cycles/probe-1'), '/api/v1/cycles/probe-1');
});

test('the authorization header never reaches a log line', () => {
  assert.deepEqual(redactHeaders({ authorization: 'Bearer secret', 'user-agent': 'curl' }), { authorization: '[redacted]', 'user-agent': 'curl' });
});
