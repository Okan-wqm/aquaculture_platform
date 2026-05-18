import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import { verifyServiceIdentityRequest } from '@aquaculture/backend-common/utils';
import {
  AuthenticatedDataSource,
  serializeApolloSubgraphBodyForSigning,
} from './authenticated-data-source';
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

describe('AuthenticatedDataSource service identity signing', () => {
  it('serializes the Apollo subgraph body exactly like RemoteGraphQLDataSource.sendRequest', () => {
    const { headers } = createHeaderCollector();
    const request = {
      query: 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }',
      variables: { input: { email: 'superadmin@example.test', password: 'redacted' } },
      operationName: 'Login',
      http: {
        method: 'POST',
        url: 'http://auth-service:3000/graphql',
        headers,
      },
    };

    expect(serializeApolloSubgraphBodyForSigning(request)).toBe(
      JSON.stringify({
        query: request.query,
        variables: request.variables,
        operationName: request.operationName,
      }),
    );
  });

  it('emits v2 headers that the downstream ServiceIdentityGuard verifies', () => {
    const dataSource = new AuthenticatedDataSource({
      url: 'http://auth-service:3000/graphql',
      secret: SECRET,
    });
    const { headers, record } = createHeaderCollector();
    const request = {
      query: 'mutation Login($input: LoginInput!) { login(input: $input) { accessToken } }',
      variables: { input: { email: 'superadmin@example.test', password: 'redacted' } },
      operationName: 'Login',
      http: {
        method: 'POST',
        url: 'http://auth-service:3000/graphql?ignored=true',
        headers,
      },
    };

    dataSource.willSendRequest({
      request,
      context: createContext(),
    } as unknown as Parameters<AuthenticatedDataSource['willSendRequest']>[0]);

    expect(
      verifyServiceIdentityRequest({
        headers: record,
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: serializeApolloSubgraphBodyForSigning(request),
        secret: SECRET,
        expectedTenantId: '',
      }),
    ).toEqual({ valid: true, version: 'v2' });
  });

  it('binds a verified tenant into the forwarded header and HMAC canonical input', () => {
    const dataSource = new AuthenticatedDataSource({
      url: 'http://farm-service:3000/graphql',
      secret: SECRET,
    });
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

    expect(record['x-tenant-id']).toBe(TENANT_ID);
    expect(
      verifyServiceIdentityRequest({
        headers: record,
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: serializeApolloSubgraphBodyForSigning(request),
        secret: SECRET,
        expectedTenantId: TENANT_ID,
      }),
    ).toEqual({ valid: true, version: 'v2' });
  });

  it('captures the old empty-body signing bug as a failing verifier contract', () => {
    const { headers } = createHeaderCollector();
    const request = {
      query: 'mutation Login { login(input: { email: "a", password: "b" }) { accessToken } }',
      http: {
        method: 'POST',
        url: 'http://auth-service:3000/graphql',
        headers,
      },
    };
    const legacyHeaders = buildSignedInternalHeaders({
      serviceName: 'gateway-api',
      tenantId: '',
      method: 'POST',
      path: '/graphql',
      body: JSON.stringify(''),
      secret: SECRET,
    });
    const wireHeaders = Object.fromEntries(
      Object.entries(legacyHeaders).map(([key, value]) => [key.toLowerCase(), value]),
    );

    expect(
      verifyServiceIdentityRequest({
        headers: wireHeaders,
        observedMethod: 'POST',
        observedPath: '/graphql',
        observedBody: serializeApolloSubgraphBodyForSigning(request),
        secret: SECRET,
        expectedTenantId: '',
      }),
    ).toEqual({ valid: false, reason: 'invalid-hmac' });
  });
});
