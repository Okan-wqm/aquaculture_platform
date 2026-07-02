import { createHash } from 'crypto';

import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import { verifyServiceIdentityRequest } from '@aquaculture/backend-common/utils';

import { AuthenticatedDataSource } from './authenticated-data-source';
import type { GatewayContext } from './authenticated-data-source';

const SECRET = 'gateway-subgraph-hmac-test-secret';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function createHeaderCollector(): {
  headers: { set: (key: string, value: string) => void };
  record: Record<string, string>;
} {
  const record: Record<string, string> = {};
  return {
    record,
    headers: {
      set: (key: string, value: string): void => {
        record[key.toLowerCase()] = value;
      },
    },
  };
}

function createContext(tenantId = ''): GatewayContext {
  return {
    req: {
      headers: tenantId ? { 'x-tenant-id': tenantId } : {},
      user: tenantId
        ? {
            sub: 'user-1',
            email: 'superadmin@example.test',
            tenantId,
            roles: ['SUPER_ADMIN'],
            iat: 1,
            exp: 2,
          }
        : undefined,
    },
    res: { append: jest.fn() } as unknown as GatewayContext['res'],
  };
}

function createCapturingDataSource(): {
  dataSource: AuthenticatedDataSource;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: AuthenticatedDataSource['fetcher'] = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({ data: { ok: true } }),
      text: async () => JSON.stringify({ data: { ok: true } }),
    } as never;
  };
  return {
    dataSource: new AuthenticatedDataSource({
      url: 'http://auth-service:3000/graphql',
      secret: SECRET,
      fetcher,
    }),
    calls,
  };
}

function lowerCaseHeaders(headers: RequestInit['headers']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers as Record<string, string>).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

function assertionHash(headers: RequestInit['headers']): string | undefined {
  const lower = lowerCaseHeaders(headers);
  const assertion = lower['x-verified-user-assertion'];
  return assertion ? createHash('sha256').update(assertion).digest('hex') : undefined;
}

function willSendRequestOptions(
  request: { query: string; http: { method: string; url: string; headers: { set: (k: string, v: string) => void } } },
  context: GatewayContext,
): Parameters<AuthenticatedDataSource['willSendRequest']>[0] {
  const options = { request, context };
  return options as Parameters<AuthenticatedDataSource['willSendRequest']>[0];
}

describe('AuthenticatedDataSource service identity signing', () => {
  it('preserves Apollo default fetcher when no custom fetcher is supplied', async () => {
    const dataSource = new AuthenticatedDataSource({
      url: 'http://127.0.0.1:1/graphql',
      secret: SECRET,
    });

    let thrown: unknown;
    try {
      await dataSource.fetcher('http://127.0.0.1:1/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    expect(String((thrown as Error).message)).not.toContain('upstream is not a function');
    expect(String((thrown as Error).message)).not.toContain('subgraph fetcher is unavailable');
  });

  it('signs the exact final fetch body that Apollo sends to the subgraph', async () => {
    const { dataSource, calls } = createCapturingDataSource();
    const wireBody = JSON.stringify({
      query: 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }',
      variables: { input: { email: 'superadmin@example.test', password: 'redacted' } },
      operationName: 'Login',
    });

    await dataSource.fetcher('http://auth-service:3000/graphql?ignored=true', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: wireBody,
    });

    const sent = calls[0]?.init;
    expect(sent).toBeDefined();
    expect(
      verifyServiceIdentityRequest({
        headers: lowerCaseHeaders(sent?.headers),
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: wireBody,
        observedQuery: '?ignored=true',
        observedContentType: 'application/json',
        secret: SECRET,
        allowUnscopedDevKey: true,
        expectedTenantId: '',
      }),
    ).toMatchObject({ valid: true, version: 'v2' });
  });

  it('binds a verified tenant into the forwarded header and final fetch-body HMAC', async () => {
    const { dataSource, calls } = createCapturingDataSource();
    const { headers, record } = createHeaderCollector();
    const request = {
      query: 'query Batches { batches { id } }',
      http: {
        method: 'POST',
        url: 'http://farm-service:3000/graphql',
        headers,
      },
    };

    dataSource.willSendRequest({
      request,
      context: createContext(TENANT_ID),
    } as unknown as Parameters<AuthenticatedDataSource['willSendRequest']>[0]);

    const wireBody = JSON.stringify({ query: request.query });
    await dataSource.fetcher('http://farm-service:3000/graphql', {
      method: 'POST',
      headers: { ...record, 'content-type': 'application/json' },
      body: wireBody,
    });

    const sent = calls[0]?.init;
    expect((sent?.headers as Record<string, string>)['X-Tenant-ID']).toBe(TENANT_ID);
    expect(
      verifyServiceIdentityRequest({
        headers: lowerCaseHeaders(sent?.headers),
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: wireBody,
        observedQuery: '',
        observedContentType: 'application/json',
        observedAssertionHash: assertionHash(sent?.headers),
        secret: SECRET,
        allowUnscopedDevKey: true,
        expectedTenantId: TENANT_ID,
      }),
    ).toMatchObject({ valid: true, version: 'v2' });
  });

  it('ORPHAN-MEDIUM-319: mints x-client-ip/x-client-user-agent on EVERY subgraph request (pre-auth included)', () => {
    const { dataSource } = createCapturingDataSource();
    const { headers, record } = createHeaderCollector();
    const context = createContext(); // NO user — the pre-auth login path
    (context.req as { ip?: string }).ip = '193.212.164.37';
    context.req.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0)';

    dataSource.willSendRequest(
      willSendRequestOptions(
        {
          query: 'mutation Login { login { accessToken } }',
          http: { method: 'POST', url: 'http://auth-service:3000/graphql', headers },
        },
        context,
      ),
    );

    expect(record['x-client-ip']).toBe('193.212.164.37');
    expect(record['x-client-user-agent']).toBe('Mozilla/5.0 (Windows NT 10.0)');
    // No user → no assertion header on the pre-auth path.
    expect(record['x-verified-user-assertion']).toBeUndefined();
  });

  it('ORPHAN-MEDIUM-319: binds clientIp/clientUserAgent into the HMAC-protected assertion for authenticated requests', () => {
    const { dataSource } = createCapturingDataSource();
    const { headers, record } = createHeaderCollector();
    const context = createContext(TENANT_ID);
    (context.req as { ip?: string }).ip = '193.212.164.37';
    context.req.headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0)';

    dataSource.willSendRequest(
      willSendRequestOptions(
        {
          query: 'query Batches { batches { id } }',
          http: { method: 'POST', url: 'http://farm-service:3000/graphql', headers },
        },
        context,
      ),
    );

    const assertionHeader = record['x-verified-user-assertion'];
    if (!assertionHeader) {
      throw new Error('expected an x-verified-user-assertion header for the authenticated path');
    }
    const assertion = JSON.parse(
      Buffer.from(assertionHeader, 'base64url').toString('utf8'),
    ) as { clientIp?: string; clientUserAgent?: string };
    expect(assertion.clientIp).toBe('193.212.164.37');
    expect(assertion.clientUserAgent).toBe('Mozilla/5.0 (Windows NT 10.0)');
  });

  it('captures the old pre-fetch-body signing bug as a failing verifier contract', async () => {
    const { dataSource, calls } = createCapturingDataSource();
    const query = 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }';
    const variables = { input: { email: 'superadmin@example.test', password: 'redacted' } };
    const guessedBodyBeforeApolloSendRequest = JSON.stringify({ query, variables });
    const actualWireBody = JSON.stringify({ query, variables, operationName: 'Login' });
    const legacyHeaders = buildSignedInternalHeaders({
      serviceName: 'gateway-api',
      tenantId: '',
      method: 'POST',
      path: '/graphql',
      body: guessedBodyBeforeApolloSendRequest,
      secret: SECRET,
    });

    expect(
      verifyServiceIdentityRequest({
        headers: Object.fromEntries(
          Object.entries(legacyHeaders).map(([key, value]) => [key.toLowerCase(), value]),
        ),
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: actualWireBody,
        secret: SECRET,
        allowUnscopedDevKey: true,
        expectedTenantId: '',
      }),
    ).toEqual({ valid: false, reason: 'invalid-hmac' });

    await dataSource.fetcher('http://auth-service:3000/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: actualWireBody,
    });

    expect(
      verifyServiceIdentityRequest({
        headers: lowerCaseHeaders(calls[0]?.init.headers),
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: actualWireBody,
        observedQuery: '',
        observedContentType: 'application/json',
        secret: SECRET,
        allowUnscopedDevKey: true,
        expectedTenantId: '',
      }),
    ).toMatchObject({ valid: true, version: 'v2' });
  });
});
