import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { VerifiedServiceIdentity } from '../../types/tenant-request.interface';
import { InternalServiceCallersGuard } from '../internal-service-callers.guard';

describe('InternalServiceCallersGuard', () => {
  let reflector: Reflector;
  let guard: InternalServiceCallersGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new InternalServiceCallersGuard(reflector);
  });

  it('allows only an identity verified upstream with an exact caller match', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['gateway-api']);
    const identity = verifiedIdentity('gateway-api');
    expect(guard.canActivate(context(identity))).toBe(true);
  });

  it.each([
    ['missing verified identity', undefined],
    ['different verified caller', verifiedIdentity('notification-service')],
  ])('denies %s', (_label, identity) => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['gateway-api']);
    expect(() => guard.canActivate(context(identity))).toThrow(ForbiddenException);
  });

  it('denies an unannotated handler instead of treating it as public', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(() => guard.canActivate(context(verifiedIdentity('gateway-api')))).toThrow(
      ForbiddenException,
    );
  });

  it('denies non-HTTP execution contexts', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['gateway-api']);
    expect(() => guard.canActivate(context(verifiedIdentity('gateway-api'), 'graphql'))).toThrow(
      ForbiddenException,
    );
  });
});

function verifiedIdentity(serviceName: string): VerifiedServiceIdentity {
  return {
    serviceName,
    tenantId: '11111111-1111-4111-8111-111111111111',
    effectiveTenantId: '11111111-1111-4111-8111-111111111111',
    keyId: 'active',
    audience: 'admin-api-service',
    nonce: 'nonce',
    version: 'v2',
  };
}

function context(
  verifiedIdentity: VerifiedServiceIdentity | undefined,
  type: 'http' | 'graphql' = 'http',
): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    getType: () => type,
    switchToHttp: () => ({
      getRequest: () => ({ verifiedIdentity }),
      getResponse: jest.fn(),
      getNext: jest.fn(),
    }),
  } as Partial<ExecutionContext> as ExecutionContext;
}
