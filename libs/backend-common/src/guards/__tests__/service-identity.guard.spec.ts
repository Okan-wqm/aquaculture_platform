import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { VerifiedServiceIdentity } from '../../types/tenant-request.interface';
import {
  generateServiceIdentityHeaders,
  generateServiceIdentityHeadersV2,
} from '../../utils/service-identity.util';
import { ServiceIdentityGuard } from '../service-identity.guard';

const SECRET = 'test-internal-secret-do-not-use-in-prod-this-is-only-a-fixture';
const TENANT = '11111111-1111-4111-8111-111111111111';

interface TestRequest {
  headers: Record<string, string>;
  method: string;
  originalUrl: string;
  body?: unknown;
  verifiedIdentity?: VerifiedServiceIdentity;
}

function lowerCaseHeaders(headers: object): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers as Record<string, string>).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
}

function createGuard(env = 'production'): ServiceIdentityGuard {
  const configService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      if (key === 'INTERNAL_SERVICE_SECRET') return SECRET;
      if (key === 'NODE_ENV') return env;
      return defaultValue;
    }),
  } as unknown as ConfigService;

  return new ServiceIdentityGuard(configService);
}

function httpContext(req: TestRequest): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: jest.fn(),
      getNext: jest.fn(),
    }),
  } as unknown as ExecutionContext;
}

function graphqlContext(req: TestRequest): ExecutionContext {
  const args = [undefined, undefined, { req }, undefined];
  return {
    getType: () => 'graphql',
    getHandler: jest.fn(),
    getClass: jest.fn(),
    getArgs: () => args,
    getArgByIndex: (index: number) => args[index],
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: jest.fn(),
      getNext: jest.fn(),
    }),
  } as unknown as ExecutionContext;
}

describe('ServiceIdentityGuard', () => {
  it('rejects unsigned HTTP farm routes in production', () => {
    const guard = createGuard('production');
    const req: TestRequest = {
      headers: {},
      method: 'GET',
      originalUrl: '/batches',
      body: undefined,
    };

    expect(() => guard.canActivate(httpContext(req))).toThrow(ForbiddenException);
  });

  it('allows health and metrics probes without service identity', () => {
    const guard = createGuard('production');
    expect(
      guard.canActivate(httpContext({ headers: {}, method: 'GET', originalUrl: '/health/ready' })),
    ).toBe(true);
    expect(
      guard.canActivate(httpContext({ headers: {}, method: 'GET', originalUrl: '/metrics' })),
    ).toBe(true);
  });

  it('accepts signed HMAC v2 HTTP requests and attaches verified identity', () => {
    const guard = createGuard('production');
    const signed = lowerCaseHeaders(
      generateServiceIdentityHeadersV2({
        serviceName: 'gateway-api',
        secret: SECRET,
        tenantId: TENANT,
        method: 'GET',
        path: '/batches',
        body: '',
      }),
    );
    const req: TestRequest = {
      headers: { ...signed, 'x-tenant-id': TENANT },
      method: 'GET',
      originalUrl: '/batches',
      body: undefined,
    };

    expect(guard.canActivate(httpContext(req))).toBe(true);
    expect(req.verifiedIdentity).toEqual(
      expect.objectContaining({
        serviceName: 'gateway-api',
        tenantId: TENANT,
        signatureVersion: 'v2',
      }),
    );
  });

  it('rejects legacy v1 service identity in production', () => {
    const guard = createGuard('production');
    const signed = lowerCaseHeaders(generateServiceIdentityHeaders('gateway-api', SECRET, TENANT));
    const req: TestRequest = {
      headers: { ...signed, 'x-tenant-id': TENANT },
      method: 'GET',
      originalUrl: '/batches',
      body: undefined,
    };

    expect(() => guard.canActivate(httpContext(req))).toThrow(ForbiddenException);
  });

  it('verifies GraphQL requests with the same HMAC v2 boundary', () => {
    const guard = createGuard('production');
    const body = { query: '{ batches { total } }' };
    const signed = lowerCaseHeaders(
      generateServiceIdentityHeadersV2({
        serviceName: 'gateway-api',
        secret: SECRET,
        tenantId: TENANT,
        method: 'POST',
        path: '/graphql',
        body: JSON.stringify(body),
      }),
    );
    const req: TestRequest = {
      headers: { ...signed, 'x-tenant-id': TENANT },
      method: 'POST',
      originalUrl: '/graphql',
      body,
    };

    expect(guard.canActivate(graphqlContext(req))).toBe(true);
    expect(req.verifiedIdentity?.signatureVersion).toBe('v2');
  });
});
