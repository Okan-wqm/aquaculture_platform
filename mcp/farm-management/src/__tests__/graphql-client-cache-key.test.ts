import { describe, expect, it } from 'vitest';

import { buildQueryCacheKey } from '../graphql/client.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const QUERY = 'query Tank($id: ID!) { tank(id: $id) { id } }';

/** K10 layer 5 (MT-HIGH-064): an MCP query cache entry belongs to exactly one tenant. */
describe('buildQueryCacheKey', () => {
  it('leads with the session tenant', () => {
    // SCENARIO: the same query + variables in tenant A's session.
    // EXPECTS: the key starts with tenant A.
    expect(buildQueryCacheKey(TENANT_A, QUERY, { id: 't1' }).startsWith(`${TENANT_A}::`)).toBe(
      true,
    );
  });

  it('never lets two tenants share an entry for the same query and variables', () => {
    // SCENARIO: tenant A and tenant B run byte-identical queries.
    // EXPECTS: different keys — B can never be served A's cached answer.
    expect(buildQueryCacheKey(TENANT_A, QUERY, { id: 't1' })).not.toBe(
      buildQueryCacheKey(TENANT_B, QUERY, { id: 't1' }),
    );
  });
});
