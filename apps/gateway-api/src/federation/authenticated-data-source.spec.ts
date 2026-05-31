import {
  VERIFIED_USER_ASSERTION_HEADER,
  VERIFIED_USER_ASSERTION_SIGNATURE_HEADER,
  buildSignedInternalHeaders,
  hashVerifiedUserAssertionHeaders,
} from '@aquaculture/backend-common/http';
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
        secret: SECRET,
        expectedTenantId: '',
      }),
    ).toEqual({ valid: true, version: 'v2' });
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
    const sentHeaders = sent?.headers as Record<string, string>;
    const sentHeadersLower = lowerCaseHeaders(sent?.headers);
    expect(sentHeaders['X-Tenant-ID']).toBe(TENANT_ID);
    expect(sentHeadersLower[VERIFIED_USER_ASSERTION_HEADER.toLowerCase()]).toBeDefined();
    expect(sentHeadersLower[VERIFIED_USER_ASSERTION_SIGNATURE_HEADER.toLowerCase()]).toBeDefined();
    expect(
      verifyServiceIdentityRequest({
        headers: sentHeadersLower,
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: wireBody,
        observedAssertionHash: hashVerifiedUserAssertionHeaders(sentHeaders),
        secret: SECRET,
        expectedTenantId: TENANT_ID,
      }),
    ).toEqual({ valid: true, version: 'v2' });
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
        secret: SECRET,
        expectedTenantId: '',
      }),
    ).toEqual({ valid: true, version: 'v2' });
  });
});
