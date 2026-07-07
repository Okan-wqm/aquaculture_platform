/**
 * JwtAuthGuard unit tests (AUDIT-HIGH-009).
 *
 * The guard is the request-time gate for every non-@Public resolver/route: it
 * extracts the Bearer token, RS256-verifies it, enforces the access-token type
 * (rejecting refresh/MFA tokens presented as access tokens), consults the token
 * blacklist (per-JTI revocation + per-user bulk invalidation), and attaches the
 * payload as request.user. Each branch is a security primitive, so each is pinned
 * here. London-school: collaborators are provided via the Nest testing module and
 * the backend-common verify helpers are stubbed.
 */
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  getJwtVerifyOptions,
  enforceAccessTokenType,
} from '@aquaculture/backend-common/auth';
import { IS_PUBLIC_KEY } from '@aquaculture/backend-common/decorators';
import { TOKEN_BLACKLIST } from '@aquaculture/backend-common/security';

import { JwtAuthGuard } from './jwt-auth.guard';

// The verify-options builder reads the public key from disk (PERF-MEDIUM-001) and
// enforceAccessTokenType is exercised in backend-common — stub both so this spec
// isolates the guard's own control flow.
jest.mock('@aquaculture/backend-common/auth', () => ({
  getJwtVerifyOptions: jest.fn(() => ({ algorithms: ['RS256'] })),
  enforceAccessTokenType: jest.fn(),
}));

interface MockRequest {
  headers: Record<string, string | undefined>;
  user?: unknown;
}

function accessPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    tenantId: 'tenant-1',
    role: 'TENANT_ADMIN',
    roles: ['TENANT_ADMIN'],
    jti: 'jti-1',
    iat: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe('JwtAuthGuard (AUDIT-HIGH-009)', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  const verifyAsync = jest.fn();
  const isValidToken = jest.fn();

  // Stub controller host backing ExecutionContext.getClass(); a named class
  // with a member satisfies @typescript-eslint/no-extraneous-class while the
  // guard only needs a Type reference for Reflector metadata lookup.
  class TestControllerHost {
    readonly isTestStub = true;
  }

  function createMockExecutionContext(request: MockRequest): ExecutionContext {
    return {
      getType: () => 'http',
      getHandler: () => () => undefined,
      getClass: () => TestControllerHost,
      getArgs: () => [],
      getArgByIndex: () => undefined,
      switchToRpc: () => ({ getData: () => ({}), getContext: () => ({}) }),
      switchToWs: () => ({ getData: () => ({}), getClient: () => ({}), getPattern: () => '' }),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
        getNext: () => undefined,
      }),
    } as ExecutionContext;
  }

  beforeEach(async () => {
    jest.mocked(enforceAccessTokenType).mockReset();
    jest.mocked(getJwtVerifyOptions).mockReturnValue({ algorithms: ['RS256'], publicKey: 'test-key' });
    verifyAsync.mockReset();
    isValidToken.mockReset().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        Reflector,
        { provide: JwtService, useValue: { verifyAsync } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test') } },
        { provide: TOKEN_BLACKLIST, useValue: { isValidToken } },
      ],
    }).compile();

    guard = module.get(JwtAuthGuard);
    reflector = module.get(Reflector);
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
  });

  it('allows @Public endpoints without inspecting a token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockExecutionContext({ headers: {} });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, expect.anything());
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    const ctx = createMockExecutionContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow('No authentication token provided');
    expect(verifyAsync).not.toHaveBeenCalled();
  });

  it('rejects a non-Bearer Authorization scheme (no token extracted)', async () => {
    const ctx = createMockExecutionContext({ headers: { authorization: 'Basic abc123' } });
    await expect(guard.canActivate(ctx)).rejects.toThrow('No authentication token provided');
  });

  it('accepts a valid access token and attaches the payload to request.user', async () => {
    const payload = accessPayload();
    verifyAsync.mockResolvedValue(payload);
    const request: MockRequest = { headers: { authorization: 'Bearer good.token' } };

    await expect(guard.canActivate(createMockExecutionContext(request))).resolves.toBe(true);
    expect(verifyAsync).toHaveBeenCalledWith('good.token', { algorithms: ['RS256'], publicKey: 'test-key' });
    expect(jest.mocked(enforceAccessTokenType)).toHaveBeenCalledWith(payload, expect.anything(), false);
    expect(request.user).toBe(payload);
  });

  it('maps a verify failure (expired / bad signature) to a generic 401', async () => {
    verifyAsync.mockRejectedValue(new Error('jwt expired'));
    const ctx = createMockExecutionContext({ headers: { authorization: 'Bearer expired.token' } });

    // Never leak the underlying jwt error to the client.
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
  });

  it('rejects a refresh/MFA token presented as an access token', async () => {
    verifyAsync.mockResolvedValue(accessPayload());
    jest.mocked(enforceAccessTokenType).mockImplementation(() => {
      throw new UnauthorizedException('Invalid token type');
    });
    const ctx = createMockExecutionContext({ headers: { authorization: 'Bearer refresh.token' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid token type');
  });

  it('rejects a blacklisted / bulk-invalidated token', async () => {
    verifyAsync.mockResolvedValue(accessPayload());
    isValidToken.mockResolvedValue(false);
    const ctx = createMockExecutionContext({ headers: { authorization: 'Bearer revoked.token' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow('Token has been revoked');
    expect(isValidToken).toHaveBeenCalledWith('jti-1', 'user-1', expect.any(Date));
  });

  it('accepts when the token blacklist is not wired (it is @Optional)', async () => {
    const moduleNoBl: TestingModule = await Test.createTestingModule({
      providers: [
        JwtAuthGuard,
        Reflector,
        { provide: JwtService, useValue: { verifyAsync } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test') } },
      ],
    }).compile();
    const guardNoBl = moduleNoBl.get(JwtAuthGuard);
    jest.spyOn(moduleNoBl.get(Reflector), 'getAllAndOverride').mockReturnValue(false);
    verifyAsync.mockResolvedValue(accessPayload());
    const request: MockRequest = { headers: { authorization: 'Bearer good.token' } };

    await expect(guardNoBl.canActivate(createMockExecutionContext(request))).resolves.toBe(true);
    expect(request.user).toBeDefined();
  });
});
