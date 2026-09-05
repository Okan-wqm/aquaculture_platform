import { resolveEdgeRules } from '../edge/edge-rule-resolver';
import { EdgeRequestFacts, RateLimitEdgeConfig } from '../rate-limit.types';

const CONFIG: RateLimitEdgeConfig = {
  tiers: {
    default: { name: 'default', limit: 100, windowMs: 60_000 },
    anonymous: { name: 'anonymous', limit: 20, windowMs: 60_000 },
    tenant: { name: 'tenant', limit: 1000, windowMs: 60_000 },
    login: { name: 'login', limit: 5, windowMs: 900_000 },
    upload: { name: 'upload', limit: 10, windowMs: 60_000 },
    mutations: { name: 'mutations', limit: 30, windowMs: 60_000 },
  },
  endpointBuckets: [
    { tier: 'login', paths: ['/auth/login'], graphqlMutations: ['login', 'verifyMfaLogin'] },
    { tier: 'upload', paths: ['/api/files/upload'] },
  ],
  mutationTier: 'mutations',
};

function facts(partial: Partial<EdgeRequestFacts>): EdgeRequestFacts {
  return { headers: {}, ...partial };
}

function names(facts: EdgeRequestFacts): string[] {
  return resolveEdgeRules(facts, CONFIG).map((r) => r.name);
}

describe('resolveEdgeRules — primary tier selection', () => {
  it('endpoint tier wins (login) even for an authenticated tenant user', () => {
    expect(names(facts({ url: '/auth/login', userId: 'u1', tenantId: 't1' }))).toEqual(['login']);
  });

  it('upload endpoint → upload tier', () => {
    expect(names(facts({ url: '/api/files/upload', userId: 'u1' }))).toEqual(['upload']);
  });

  it('JWT tenant → tenant tier (no endpoint match)', () => {
    expect(names(facts({ url: '/graphql', userId: 'u1', tenantId: 't1' }))).toEqual(['tenant']);
  });

  it('no user → anonymous tier', () => {
    expect(names(facts({ url: '/graphql' }))).toEqual(['anonymous']);
  });

  it('authenticated without tenant → default tier', () => {
    expect(names(facts({ url: '/graphql', userId: 'u1' }))).toEqual(['default']);
  });

  it('resolves limit/window from the chosen tier', () => {
    const [rule] = resolveEdgeRules(facts({ url: '/auth/login' }), CONFIG);
    expect(rule).toMatchObject({ name: 'login', limit: 5, windowMs: 900_000 });
  });
});

describe('resolveEdgeRules — additive mutation tier (gateway MutationGuard parity)', () => {
  it('GraphQL mutation adds the mutations tier ON TOP of the identity tier', () => {
    // Anonymous mutation must be bounded by BOTH anonymous (20) AND mutations
    // (30) — never loosened to only the mutation cap.
    expect(names(facts({ url: '/graphql', graphqlParentType: 'Mutation' }))).toEqual([
      'anonymous',
      'mutations',
    ]);
  });

  it('authenticated tenant mutation → [tenant, mutations]', () => {
    expect(
      names(
        facts({ url: '/graphql', graphqlParentType: 'Mutation', userId: 'u1', tenantId: 't1' }),
      ),
    ).toEqual(['tenant', 'mutations']);
  });

  it('GraphQL query does NOT add the mutation tier', () => {
    expect(names(facts({ url: '/graphql', graphqlParentType: 'Query', userId: 'u1' }))).toEqual([
      'default',
    ]);
  });

  it('no mutation rule when mutationTier is unconfigured', () => {
    const noMutation: RateLimitEdgeConfig = { ...CONFIG, mutationTier: undefined };
    expect(
      resolveEdgeRules(facts({ graphqlParentType: 'Mutation' }), noMutation).map((r) => r.name),
    ).toEqual(['anonymous']);
  });

  it('does NOT add the mutation tier for a Subscription (exact "Mutation" match only)', () => {
    // Defensive: a refactor to a loose "contains Mutation" check would wrongly
    // rate-limit subscriptions as mutations. Only the exact parent type counts.
    expect(
      names(facts({ url: '/graphql', graphqlParentType: 'Subscription', userId: 'u1' })),
    ).toEqual(['default']);
  });

  it('an endpoint-tier request that is ALSO a GraphQL mutation stays additive [endpoint, mutations]', () => {
    // Mirrors the old two-independent-guards behavior: the endpoint tier and the
    // mutation cap both apply (neither cancels the other). In practice login is
    // HTTP (no graphqlParentType) so this is the defensive co-occurrence case.
    expect(
      names(facts({ url: '/auth/login', graphqlParentType: 'Mutation', userId: 'u1' })),
    ).toEqual(['login', 'mutations']);
  });
});

describe('resolveEdgeRules — GraphQL login mutation is the login tier (SEC-HIGH-061)', () => {
  it('anonymous `login` mutation → [login, mutations], not [anonymous, mutations]', () => {
    expect(
      names(facts({ url: '/graphql', graphqlParentType: 'Mutation', graphqlFieldName: 'login' })),
    ).toEqual(['login', 'mutations']);
  });

  it('an authenticated tenant user re-authenticating is still the login tier', () => {
    expect(
      names(
        facts({
          url: '/graphql',
          graphqlParentType: 'Mutation',
          graphqlFieldName: 'verifyMfaLogin',
          userId: 'u1',
          tenantId: 't1',
        }),
      ),
    ).toEqual(['login', 'mutations']);
  });

  it('an unlisted mutation keeps the identity tier', () => {
    expect(
      names(
        facts({ url: '/graphql', graphqlParentType: 'Mutation', graphqlFieldName: 'createBatch' }),
      ),
    ).toEqual(['anonymous', 'mutations']);
  });

  it('a Query field named login is not the login tier', () => {
    expect(
      names(
        facts({
          url: '/graphql',
          graphqlParentType: 'Query',
          graphqlFieldName: 'login',
          userId: 'u1',
        }),
      ),
    ).toEqual(['default']);
  });

  it('the login rule carries the login limit and window', () => {
    const [rule] = resolveEdgeRules(
      facts({ url: '/graphql', graphqlParentType: 'Mutation', graphqlFieldName: 'login' }),
      CONFIG,
    );
    expect(rule).toMatchObject({ name: 'login', limit: 5, windowMs: 900_000 });
  });
});
