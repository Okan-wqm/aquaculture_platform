import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { AuthGuard } from '../auth.guard';
import type { GatewayTokenVerifierService } from '../gateway-token-verifier.service';
import type { ApiKeyAuthStrategy } from '../strategies/api-key-auth.strategy';
import type { BasicAuthStrategy } from '../strategies/basic-auth.strategy';
import type { AuthenticatedRequest, JwtPayload } from '../../types';

interface GatewayVerifiedJwtRequest extends AuthenticatedRequest {
  gatewayVerifiedJwtPayload?: JwtPayload;
}

function jwtPayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    sub: 'user-1',
    tenantId: 'tenant-1',
    roles: ['MODULE_USER'],
    type: 'access',
    jti: 'jti-1',
    iat: 1_700_000_000,
    exp: 1_700_001_000,
    ...overrides,
  };
}

function httpContext(request: GatewayVerifiedJwtRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
    getType: () => 'http',
  } as unknown as ExecutionContext;
}

describe('AuthGuard gateway verifier SSoT', () => {
  let tokenVerifier: jest.Mocked<
    Pick<GatewayTokenVerifierService, 'isPayloadAllowed' | 'verifyAccessToken'>
  >;
  let guard: AuthGuard;

  beforeEach(() => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const apiKeyAuthStrategy = {
      validate: jest.fn(),
    } as unknown as ApiKeyAuthStrategy;
    const basicAuthStrategy = {
      validate: jest.fn(),
    } as unknown as BasicAuthStrategy;
    tokenVerifier = {
      isPayloadAllowed: jest.fn().mockResolvedValue(true),
      verifyAccessToken: jest.fn(),
    };

    guard = new AuthGuard(
      reflector,
      apiKeyAuthStrategy,
      basicAuthStrategy,
      tokenVerifier as unknown as GatewayTokenVerifierService,
    );
  });

  it('uses the JWT payload captured by JwtMiddleware, not a later req.user overwrite', async () => {
    const trustedPayload = jwtPayload({ sub: 'trusted-user', tenantId: 'trusted-tenant' });
    const spoofedPayload = jwtPayload({ sub: 'spoofed-user', tenantId: 'spoofed-tenant' });
    const request = {
      headers: {},
      user: spoofedPayload,
      jwtVerified: true,
      gatewayVerifiedJwtPayload: trustedPayload,
    } as GatewayVerifiedJwtRequest;

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);

    expect(tokenVerifier.isPayloadAllowed).toHaveBeenCalledWith(trustedPayload, 'AuthGuard.cached');
    expect(request.user).toBe(trustedPayload);
    expect(request.authMethod).toBe('jwt');
  });

  it('does not accept req.user without a gateway-verified JWT payload', async () => {
    const request = {
      headers: {},
      user: jwtPayload({ sub: 'spoofed-user' }),
    } as GatewayVerifiedJwtRequest;

    await expect(guard.canActivate(httpContext(request))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(request.user).toBeUndefined();
    expect(tokenVerifier.isPayloadAllowed).not.toHaveBeenCalled();
    expect(tokenVerifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('stores the fully verified payload after AuthGuard token verification', async () => {
    const verifiedPayload = jwtPayload({ sub: 'verified-user' });
    tokenVerifier.verifyAccessToken.mockResolvedValue(verifiedPayload);
    const request = {
      headers: { authorization: 'Bearer token' },
    } as GatewayVerifiedJwtRequest;

    await expect(guard.canActivate(httpContext(request))).resolves.toBe(true);

    expect(tokenVerifier.verifyAccessToken).toHaveBeenCalledWith('token', {
      context: 'AuthGuard.fullVerify',
    });
    expect(request.user).toBe(verifiedPayload);
    expect(request.jwtVerified).toBe(true);
    expect(request.gatewayVerifiedJwtPayload).toBe(verifiedPayload);
  });
});
