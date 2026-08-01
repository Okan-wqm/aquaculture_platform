/**
 * Regression coverage for the middleware -> AuthGuard JWT revocation chain.
 *
 * A user-level invalidation can make isValidToken() false while the token's
 * individual JTI is not blacklisted. Historically JwtMiddleware left req.user
 * empty in that case, then AuthGuard re-verified the bearer and checked only
 * isBlacklisted(jti), resurrecting the revoked token. These tests pin the
 * composite JTI/user/iat contract at every entry path.
 */
import * as crypto from 'node:crypto';

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { JwtService } from '@nestjs/jwt';
import express, { NextFunction, Response } from 'express';

import { AuthenticatedRequest, JwtPayload } from '../../types/index';
import { JwtMiddleware } from '../../middleware/jwt.middleware';
import { AuthGuard } from '../auth.guard';
import { TokenBlacklistStore } from '../redis-token-blacklist.store';
import { ApiKeyAuthStrategy } from '../strategies/api-key-auth.strategy';
import { BasicAuthStrategy } from '../strategies/basic-auth.strategy';

interface ExceptionResponse {
  code?: string;
}

class TestController {}
const noopHandler = (): void => undefined;

describe('JWT composite revocation chain', () => {
  const issuer = 'revocation-chain-test-issuer';
  const audience = 'revocation-chain-test-audience';
  const keyPair = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: 'user-revoked-at-epoch',
    tenantId: 'tenant-1',
    roles: ['MODULE_USER'],
    type: 'access',
    jti: 'jti-still-clean',
    iat: issuedAt,
    exp: issuedAt + 3600,
    iss: issuer,
    aud: audience,
  };

  let jwtService: JwtService;
  let middleware: JwtMiddleware;
  let guard: AuthGuard;
  let tokenBlacklist: jest.Mocked<TokenBlacklistStore>;
  let token: string;

  beforeEach(() => {
    jwtService = new JwtService({});
    const configService = new ConfigService({
      NODE_ENV: 'production',
      JWT_PUBLIC_KEY: keyPair.publicKey,
      JWT_ISSUER: issuer,
      JWT_AUDIENCE: audience,
    });

    tokenBlacklist = {
      isBlacklisted: jest.fn().mockResolvedValue(false),
      isValidToken: jest.fn().mockResolvedValue(false),
    };

    middleware = new JwtMiddleware(jwtService, configService, tokenBlacklist);
    guard = new AuthGuard(
      new Reflector(),
      configService,
      jwtService,
      new ApiKeyAuthStrategy(configService),
      new BasicAuthStrategy(configService),
      tokenBlacklist,
    );

    token = jwtService.sign(payload, {
      privateKey: keyPair.privateKey,
      algorithm: 'RS256',
    });
  });

  function response(): Response {
    // Clone the real Express response prototype so middleware collaborators get
    // the framework contract without a broad type assertion.
    return Object.create(express.response);
  }

  function requestWithBearer(): AuthenticatedRequest {
    // Clone the real Express request prototype and set only the request-owned
    // fields used by this chain. This avoids cast-through-unknown test doubles.
    const request: AuthenticatedRequest = Object.create(express.request);
    request.headers = { authorization: `Bearer ${token}` };
    request.method = 'GET';
    request.url = '/graphql';
    return request;
  }

  function httpContext(request: AuthenticatedRequest): ExecutionContext {
    const context = new ExecutionContextHost([request, response()], TestController, noopHandler);
    context.setType('http');
    return context;
  }

  async function expectRevoked(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      fail('Expected TOKEN_REVOKED');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      if (!(error instanceof UnauthorizedException)) {
        throw error;
      }
      expect(error.getResponse()).toMatchObject({
        code: 'TOKEN_REVOKED',
      } satisfies ExceptionResponse);
    }
  }

  it('cannot resurrect a user-revoked token after middleware leaves req.user empty', async () => {
    const request = requestWithBearer();
    const next: NextFunction = jest.fn();

    await middleware.use(request, response(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.user).toBeUndefined();
    expect(request.jwtAuthenticationFailure).toBe('TOKEN_REVOKED');
    expect(tokenBlacklist.isValidToken).toHaveBeenCalledWith(payload.jti, payload.sub, payload.iat);

    await expectRevoked(() => guard.canActivate(httpContext(request)));

    // The explicit middleware outcome is final. In particular, the guard must
    // not fall back to the weaker per-JTI check that says this JTI is clean.
    expect(tokenBlacklist.isValidToken).toHaveBeenCalledTimes(1);
    expect(tokenBlacklist.isBlacklisted).not.toHaveBeenCalled();
  });

  it('uses composite user/JTI/iat validity on the full verification path', async () => {
    const request = requestWithBearer();

    await expectRevoked(() => guard.canActivate(httpContext(request)));

    expect(tokenBlacklist.isValidToken).toHaveBeenCalledWith(payload.jti, payload.sub, payload.iat);
    expect(tokenBlacklist.isBlacklisted).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
  });

  it('uses composite user/JTI/iat validity on the middleware-populated fast path', async () => {
    const request = requestWithBearer();
    request.user = { ...payload };

    await expectRevoked(() => guard.canActivate(httpContext(request)));

    expect(tokenBlacklist.isValidToken).toHaveBeenCalledWith(payload.jti, payload.sub, payload.iat);
    expect(tokenBlacklist.isBlacklisted).not.toHaveBeenCalled();
    expect(request.user).toBeUndefined();
    expect(request.jwtAuthenticationFailure).toBe('TOKEN_REVOKED');
  });

  it('rechecks composite validity in the guard to close the middleware-to-guard race', async () => {
    tokenBlacklist.isValidToken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const request = requestWithBearer();
    const next: NextFunction = jest.fn();

    await middleware.use(request, response(), next);
    expect(request.user).toEqual(payload);

    await expectRevoked(() => guard.canActivate(httpContext(request)));

    expect(tokenBlacklist.isValidToken).toHaveBeenCalledTimes(2);
    expect(request.user).toBeUndefined();
    expect(request.jwtAuthenticationFailure).toBe('TOKEN_REVOKED');
  });

  it('marks a middleware revocation-store failure as revoked and fails closed', async () => {
    tokenBlacklist.isValidToken.mockRejectedValueOnce(new Error('revocation backend unavailable'));
    const request = requestWithBearer();
    const next: NextFunction = jest.fn();

    await middleware.use(request, response(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(request.user).toBeUndefined();
    expect(request.jwtAuthenticationFailure).toBe('TOKEN_REVOKED');
    await expectRevoked(() => guard.canActivate(httpContext(request)));
  });

  it('fails closed when a custom revocation store throws', async () => {
    tokenBlacklist.isValidToken.mockRejectedValueOnce(new Error('revocation backend unavailable'));
    const request = requestWithBearer();

    await expectRevoked(() => guard.canActivate(httpContext(request)));

    expect(request.user).toBeUndefined();
    expect(request.jwtAuthenticationFailure).toBe('TOKEN_REVOKED');
  });
});
