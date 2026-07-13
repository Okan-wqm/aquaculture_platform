import 'reflect-metadata';

import { enforceAccessTokenType } from '@aquaculture/backend-common/auth';
import { IS_PUBLIC_KEY, Role } from '@aquaculture/backend-common/decorators';
import {
  RATE_LIMIT_CONFIG_KEY,
  RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AuditLogService } from '../../../audit/audit-log.service';
import { User } from '../entities/user.entity';
import { MfaResolver } from '../resolvers/mfa.resolver';
import { MfaService } from '../services/mfa.service';
import { TokenService } from '../services/token.service';

/**
 * ADR-042 — mfa_setup (enrollment) token mechanics.
 *
 * The setup token is the pre-session credential login returns when a tenant
 * enforces MFA and the user has none enrolled. This suite pins its full
 * authorization envelope:
 *   - minted with type 'mfa_setup' + 10-minute TTL (mirrors mfa_challenge)
 *   - accepted ONLY by resolveSetupTokenUserId (setupMfa/verifyMfaSetup)
 *   - rejected as a bearer credential (real enforceAccessTokenType)
 *   - rejected by verifyMfaLogin (positive mfa_challenge type check)
 *   - resolver subject precedence: authenticated session wins over the token
 */

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-uuid-123',
    email: 'test@example.com',
    role: Role.MODULE_USER,
    tenantId: 'tenant-uuid-123',
    isActive: true,
    mfaEnabled: false,
    mfaSecret: null,
    mfaRecoveryCodes: null,
    mfaFailedAttempts: 0,
    mfaLockedUntil: null,
    ...overrides,
  });
  return user;
};

const mockUserRepository = {
  findOne: jest.fn(),
  save: jest.fn((user: User) => Promise.resolve(user)),
  createQueryBuilder: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('signed-mfa-setup-token'),
  verify: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: unknown) => {
    const config: Record<string, unknown> = {
      MFA_ENCRYPTION_KEY: 'a'.repeat(64),
      MFA_ISSUER_NAME: 'TestApp',
      NODE_ENV: 'test',
    };
    return config[key] ?? defaultValue;
  }),
};

const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
const mockTokenService = { generateTokens: jest.fn() };

describe('MfaService — mfa_setup token (ADR-042)', () => {
  let service: MfaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockJwtService.sign.mockReturnValue('signed-mfa-setup-token');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MfaService,
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AuditLogService, useValue: mockAuditLogService },
        { provide: TokenService, useValue: mockTokenService },
      ],
    }).compile();

    service = module.get<MfaService>(MfaService);
  });

  describe('generateMfaSetupToken', () => {
    it('mints a JWT with type mfa_setup, purpose mfa_enrollment, prefixed sub, and 10-minute TTL', () => {
      const user = createMockUser();

      const token = service.generateMfaSetupToken(user);

      expect(token).toBe('signed-mfa-setup-token');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'mfa_setup:user-uuid-123',
          type: 'mfa_setup',
          purpose: 'mfa_enrollment',
          userId: 'user-uuid-123',
          jti: expect.any(String),
        }),
        { expiresIn: 600 },
      );
    });
  });

  describe('resolveSetupTokenUserId', () => {
    it('resolves the userId from a valid mfa_setup token', () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa_setup:user-uuid-123',
        type: 'mfa_setup',
        purpose: 'mfa_enrollment',
        userId: 'user-uuid-123',
      });

      expect(service.resolveSetupTokenUserId('a-setup-token')).toBe('user-uuid-123');
    });

    it('rejects an mfa_challenge token (cross-surface replay)', () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa:user-uuid-123',
        type: 'mfa_challenge',
        purpose: 'mfa_verification',
        userId: 'user-uuid-123',
      });

      expect(() => service.resolveSetupTokenUserId('a-challenge-token')).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an access token (bearer replay into the enrollment surface)', () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'user-uuid-123',
        type: 'access',
        userId: 'user-uuid-123',
      });

      expect(() => service.resolveSetupTokenUserId('an-access-token')).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a garbage/expired token (verify throws)', () => {
      mockJwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      expect(() => service.resolveSetupTokenUserId('expired')).toThrow(
        /invalid or expired/i,
      );
    });
  });

  describe('token-type symmetry', () => {
    it('the REAL enforceAccessTokenType rejects an mfa_setup payload on every bearer surface', () => {
      expect(() =>
        enforceAccessTokenType(
          { sub: 'mfa_setup:user-uuid-123', type: 'mfa_setup', jti: 'x' },
          new Logger('spec'),
          true,
        ),
      ).toThrow(UnauthorizedException);
    });

    it('verifyMfaLogin rejects an mfa_setup token (positive mfa_challenge check)', async () => {
      mockJwtService.verify.mockReturnValue({
        sub: 'mfa_setup:user-uuid-123',
        type: 'mfa_setup',
        purpose: 'mfa_enrollment',
        userId: 'user-uuid-123',
        jti: 'x',
      });

      await expect(service.verifyMfaLogin('a-setup-token', '123456')).rejects.toThrow(
        'Invalid MFA token',
      );
    });
  });
});

describe('MfaResolver — enrollment subject resolution (ADR-042)', () => {
  const mfaServiceStub = {
    setupMfa: jest.fn().mockResolvedValue({ secret: 's', qrCodeUri: 'q', recoveryCodes: [] }),
    verifyMfaSetup: jest.fn().mockResolvedValue({ success: true }),
    resolveSetupTokenUserId: jest.fn().mockReturnValue('token-user-id'),
  };
  const configStub = { get: jest.fn((_k: string, d?: unknown) => d) };

  let resolver: MfaResolver;
  const buildResolver = (): MfaResolver => resolver;

  beforeAll(async () => {
    // Nest testing module resolves collaborators without type casts —
    // useValue providers are untyped at the DI boundary by design.
    const moduleRef = await Test.createTestingModule({
      providers: [
        MfaResolver,
        { provide: MfaService, useValue: mfaServiceStub },
        { provide: ConfigService, useValue: configStub },
      ],
    }).compile();
    resolver = moduleRef.get(MfaResolver);
  });

  // Structural GqlContext: exactly the surface the resolver's narrowed
  // context type (Pick<Request,...> / Pick<Response,'cookie'>) requires.
  const buildCtx = (
    user?: { sub: string },
  ): {
    req: { headers: Record<string, never>; ip: string; user?: { sub: string } };
    res: { cookie: jest.Mock };
  } => ({
    req: { headers: {}, ip: '127.0.0.1', ...(user ? { user } : {}) },
    res: { cookie: jest.fn() },
  });
  const authenticatedCtx = (sub: string): ReturnType<typeof buildCtx> => buildCtx({ sub });
  const anonymousCtx = (): ReturnType<typeof buildCtx> => buildCtx();

  beforeEach(() => {
    jest.clearAllMocks();
    mfaServiceStub.resolveSetupTokenUserId.mockReturnValue('token-user-id');
  });

  it('setupMfa: authenticated session wins — the setup token argument is ignored', async () => {
    await buildResolver().setupMfa(authenticatedCtx('session-user-id'), 'some-setup-token');

    expect(mfaServiceStub.setupMfa).toHaveBeenCalledWith('session-user-id');
    expect(mfaServiceStub.resolveSetupTokenUserId).not.toHaveBeenCalled();
  });

  it('setupMfa: no session + valid setup token → subject comes from the token', async () => {
    await buildResolver().setupMfa(anonymousCtx(), 'some-setup-token');

    expect(mfaServiceStub.resolveSetupTokenUserId).toHaveBeenCalledWith('some-setup-token');
    expect(mfaServiceStub.setupMfa).toHaveBeenCalledWith('token-user-id');
  });

  it('setupMfa: no session + no token → UnauthorizedException (never anonymous)', async () => {
    await expect(buildResolver().setupMfa(anonymousCtx())).rejects.toThrow(
      UnauthorizedException,
    );
    expect(mfaServiceStub.setupMfa).not.toHaveBeenCalled();
  });

  it('verifyMfaSetup: no session + token in input → subject from the token', async () => {
    await buildResolver().verifyMfaSetup(anonymousCtx(), {
      code: '123456',
      mfaSetupToken: 'some-setup-token',
    });

    expect(mfaServiceStub.resolveSetupTokenUserId).toHaveBeenCalledWith('some-setup-token');
    expect(mfaServiceStub.verifyMfaSetup).toHaveBeenCalledWith('token-user-id', '123456');
  });

  it('verifyMfaSetup: authenticated session wins over input token', async () => {
    await buildResolver().verifyMfaSetup(authenticatedCtx('session-user-id'), {
      code: '123456',
      mfaSetupToken: 'some-setup-token',
    });

    expect(mfaServiceStub.verifyMfaSetup).toHaveBeenCalledWith('session-user-id', '123456');
    expect(mfaServiceStub.resolveSetupTokenUserId).not.toHaveBeenCalled();
  });
});

describe('MfaResolver — enrollment surface contract (ADR-042)', () => {
  const metadataOf = <T>(method: string, key: string): T | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(MfaResolver.prototype, method);
    if (!descriptor?.value) return undefined;
    return Reflect.getMetadata(key, descriptor.value as object) as T | undefined;
  };

  it.each(['setupMfa', 'verifyMfaSetup'])(
    '%s is @Public (pre-session enrollment reachable with the mfa_setup token)',
    (method) => {
      expect(metadataOf<boolean>(method, IS_PUBLIC_KEY)).toBe(true);
    },
  );

  it('setupMfa carries @RateLimit(5 / 15m) keyed by the setup token', () => {
    const config = metadataOf<RateLimitRouteConfig>('setupMfa', RATE_LIMIT_CONFIG_KEY);
    expect(config).toBeDefined();
    expect(config?.limit).toBe(5);
    expect(config?.windowMs).toBe(15 * 60_000);
    expect(config?.identifier?.({ args: { mfaSetupToken: 'setup-1' } })).toBe('setup-1');
    // Authenticated calls carry no token arg → dimension skipped.
    expect(config?.identifier?.({ args: {} })).toBeUndefined();
  });

  it('verifyMfaSetup carries @RateLimit(5 / 15m) keyed by the setup token in the input', () => {
    const config = metadataOf<RateLimitRouteConfig>('verifyMfaSetup', RATE_LIMIT_CONFIG_KEY);
    expect(config).toBeDefined();
    expect(config?.limit).toBe(5);
    expect(config?.windowMs).toBe(15 * 60_000);
    expect(
      config?.identifier?.({ args: { input: { mfaSetupToken: 'setup-2' } } }),
    ).toBe('setup-2');
    expect(config?.identifier?.({ args: { input: {} } })).toBeUndefined();
  });
});
