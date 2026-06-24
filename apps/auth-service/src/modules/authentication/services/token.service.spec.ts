import { getActiveSigningKid } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import { ISessionManager, SESSION_MANAGER } from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';

import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

import { JwtPayload, TokenService } from './token.service';

// WHY: bcryptjs publishes a sealed module namespace under the current
// toolchain — jest.spyOn(bcrypt, 'hash') throws "Cannot redefine property"
// (see authentication.service.spec.ts for the same constraint). Re-exporting
// hash as a plain jest.fn wrapper (default behaviour = the real implementation)
// restores mock-ability while keeping production-equivalent hashing for tests
// that don't stub.
jest.mock('bcryptjs', () => {
  const actual = jest.requireActual<typeof bcrypt>('bcryptjs');
  // Bind the promise overload explicitly — jest.fn over the raw overloaded
  // function resolves the callback overload and trips no-misused-promises.
  const promiseHash: (data: string, saltOrRounds: string | number) => Promise<string> =
    actual.hash;
  return { ...actual, hash: jest.fn(promiseHash) };
});

// Typed alias over the spy-able wrapper above. The explicit type argument
// selects hash's promise overload; jest.mocked over the raw overloaded type
// would collapse mockResolvedValue to never.
const mockBcryptHash = jest.mocked<(data: string, saltOrRounds: string | number) => Promise<string>>(
  bcrypt.hash,
);

/**
 * MT-MEDIUM-001 — the `planLevel` JWT claim.
 *
 * generateTokens must stamp the tenant's plan-tier ordinal onto the access
 * token so downstream services gate by tier without a per-request lookup, and
 * must OMIT the claim for platform accounts that have no tenant.
 */
describe('TokenService — planLevel JWT claim (MT-MEDIUM-001)', () => {
  let service: TokenService;
  let signAsync: jest.Mock;
  let query: jest.Mock;
  // The signAsync mock captures its typed payload here, so the assertion helper
  // reads a JwtPayload-typed value rather than an `any` from mock.calls.
  let lastPayload: JwtPayload | undefined;

  /** The payload handed to jwtService.signAsync on the single expected call. */
  const capturedPayload = (): JwtPayload => {
    expect(signAsync).toHaveBeenCalledTimes(1);
    if (!lastPayload) {
      throw new Error('signAsync was not called with a payload');
    }
    return lastPayload;
  };

  const buildUser = (overrides: Partial<User>): User =>
    Object.assign(new User(), {
      id: '11111111-1111-1111-1111-111111111111',
      role: Role.TENANT_ADMIN,
      tenantId: '22222222-2222-2222-2222-222222222222',
      ...overrides,
    });

  beforeEach(async () => {
    lastPayload = undefined;
    signAsync = jest.fn((payload: JwtPayload) => {
      lastPayload = payload;
      return Promise.resolve('signed.access.token');
    });
    // Route the two reads generateTokens performs: the tenant_modules lookup
    // (empty) and the auth.tenants plan lookup (professional → ordinal 2).
    query = jest.fn((sql: string) => {
      if (typeof sql === 'string' && sql.includes('FROM auth.tenants')) {
        return Promise.resolve([{ plan: 'professional' }]);
      }
      return Promise.resolve([]);
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        // SEC-HIGH-051/052: TokenService now requires the site-assignment repo +
        // mobile-settings read path. Empty defaults keep this suite's claims
        // (assignedSiteIds/mobileFeatures) absent — they assert the OTHER claims.
        {
          provide: getRepositoryToken(UserSiteAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MobileSettingsService,
          // getByUserId NEVER returns null (it creates a default row); a DISABLED
          // settings object yields empty mobileFeatures, keeping this suite's claims absent.
          useValue: { getByUserId: jest.fn().mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }) },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn((x: unknown) => x), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: DataSource, useValue: { query } },
        { provide: JwtService, useValue: { signAsync } },
        {
          provide: ConfigService,
          useValue: {
            // HASH_REFRESH_TOKENS=false skips bcrypt; every other key resolves to
            // its caller-supplied default.
            get: jest.fn((key: string, def?: unknown) =>
              key === 'HASH_REFRESH_TOKENS' ? false : def,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('includes the tenant plan ordinal as planLevel', async () => {
    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(2); // professional → PLAN_LEVEL 2
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM auth.tenants'),
      ['22222222-2222-2222-2222-222222222222'],
    );
  });

  it('omits planLevel for a platform account with no tenant', async () => {
    await service.generateTokens(
      buildUser({ role: Role.SUPER_ADMIN, tenantId: null }),
    );

    const payload = capturedPayload();
    expect('planLevel' in payload).toBe(false);
    // No tenant → the auth.tenants plan lookup must never run.
    expect(query).not.toHaveBeenCalledWith(
      expect.stringContaining('FROM auth.tenants'),
      expect.anything(),
    );
  });

  it('falls back to 0 for an unrecognised plan string', async () => {
    query.mockImplementation((sql: string) =>
      typeof sql === 'string' && sql.includes('FROM auth.tenants')
        ? Promise.resolve([{ plan: 'legacy-unknown' }])
        : Promise.resolve([]),
    );

    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(0);
  });
});

/**
 * AUDIT-HIGH-009 — generateTokens security-surface coverage.
 *
 * This suite hardens the harness the planLevel suite established: it provides a
 * SESSION_MANAGER, a configurable ConfigService (so HASH_REFRESH_TOKENS can be
 * flipped per-test), and a query router keyed on SQL substring so the FULL flow
 * (modules, resource-permissions JOIN, plan lookup, session path) runs end to
 * end rather than returning `[]` for everything.
 *
 * The blocks below lock:
 *   (A) PII-free payload (H-08)
 *   (B) audience + kid on signAsync (SEC-HIGH-003)
 *   (C) type === 'access' discriminator
 *   (D) getUserResourcePermissions injection guard (SEC-M13) + fail-loud (PERF-HIGH-001)
 *   (E) module LRU eviction + TTL
 *   (F) omit-when-empty modules / resourcePermissions shaping
 *   (G) SessionManager enforce + create path
 */
describe('TokenService — generateTokens security surface (AUDIT-HIGH-009)', () => {
  let service: TokenService;
  let signAsync: jest.Mock;
  let query: jest.Mock;
  let refreshSave: jest.Mock;
  let enforceSessionLimit: jest.Mock;
  let createSession: jest.Mock;
  let configValues: Record<string, unknown>;
  let lastPayload: JwtPayload | undefined;

  // A valid 16-hex tenant id whose first 16 chars derive a well-formed
  // tenant_<hex16> schema name, so the SEC-M13 regex guard passes and the
  // resource-permission JOIN is actually issued.
  const VALID_TENANT_ID = 'abcdef01-2345-6789-abcd-ef0123456789';

  const capturedPayload = (): JwtPayload => {
    if (!lastPayload) {
      throw new Error('signAsync was not called with a payload');
    }
    return lastPayload;
  };

  const buildUser = (overrides: Partial<User>): User =>
    Object.assign(new User(), {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'pii@example.com',
      firstName: 'Pii',
      lastName: 'User',
      phoneNumber: '+10000000000',
      role: Role.MODULE_USER,
      tenantId: VALID_TENANT_ID,
      ...overrides,
    });

  // Deterministic SQL router: resource-permission JOIN, plan lookup, modules.
  const buildQueryRouter = (overrides?: {
    resourcePermissions?: Array<{ resource_permissions: string[] | null }>;
    plan?: string;
    onResourceQuery?: (sql: string) => Promise<unknown>;
  }): jest.Mock =>
    jest.fn((sql: string) => {
      if (typeof sql !== 'string') {
        return Promise.resolve([]);
      }
      if (sql.includes('user_role_assignments') && sql.includes('tenant_role_permissions')) {
        if (overrides?.onResourceQuery) {
          return overrides.onResourceQuery(sql);
        }
        return Promise.resolve(overrides?.resourcePermissions ?? []);
      }
      if (sql.includes('FROM auth.tenants')) {
        return Promise.resolve([{ plan: overrides?.plan ?? 'professional' }]);
      }
      return Promise.resolve([]);
    });

  const createService = async (deps?: {
    query?: jest.Mock;
    config?: Record<string, unknown>;
    moduleAssignmentFind?: jest.Mock;
  }): Promise<TokenService> => {
    configValues = { HASH_REFRESH_TOKENS: false, ...(deps?.config ?? {}) };
    query = deps?.query ?? buildQueryRouter();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        // SEC-HIGH-051/052: TokenService now requires the site-assignment repo +
        // mobile-settings read path. Empty defaults keep this suite's claims
        // (assignedSiteIds/mobileFeatures) absent — they assert the OTHER claims.
        {
          provide: getRepositoryToken(UserSiteAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: MobileSettingsService,
          // getByUserId NEVER returns null (it creates a default row); a DISABLED
          // settings object yields empty mobileFeatures, keeping this suite's claims absent.
          useValue: { getByUserId: jest.fn().mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }) },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn((x: unknown) => x), save: refreshSave },
        },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: {
            find: deps?.moduleAssignmentFind ?? jest.fn().mockResolvedValue([]),
          },
        },
        { provide: DataSource, useValue: { query } },
        { provide: JwtService, useValue: { signAsync } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) =>
              key in configValues ? configValues[key] : def,
            ),
          },
        },
        {
          provide: SESSION_MANAGER,
          useValue: {
            enforceSessionLimit,
            createSession,
          } as Partial<ISessionManager>,
        },
      ],
    }).compile();

    return module.get<TokenService>(TokenService);
  };

  beforeEach(() => {
    lastPayload = undefined;
    signAsync = jest.fn((payload: JwtPayload) => {
      lastPayload = payload;
      return Promise.resolve('signed.access.token');
    });
    refreshSave = jest.fn().mockResolvedValue(undefined);
    enforceSessionLimit = jest.fn().mockResolvedValue([]);
    createSession = jest.fn().mockResolvedValue('session-id');
  });

  // Prevent the shared signAsync/query/bcrypt mocks from bleeding across blocks
  // (ties to AUDIT-MEDIUM-015 — deterministic, isolated specs). restoreAllMocks
  // restores any jest.spyOn (e.g. Date.now); clearAllMocks wipes call history;
  // the bcrypt hash wrapper's per-test implementation is reset explicitly so it
  // falls back to the real hash for blocks that do not stub it.
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    mockBcryptHash.mockReset();
  });

  // (A) PII-free payload — H-08.
  describe('PII-free payload (H-08)', () => {
    const ALLOWED_KEYS = new Set([
      'sub',
      'role',
      'roles',
      'tenantId',
      'planLevel',
      'modules',
      'resourcePermissions',
      'type',
      'jti',
      'mfaVerified',
    ]);

    it('carries no email / firstName / lastName / phone in the payload', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}));

      const payload = capturedPayload();
      expect('email' in payload).toBe(false);
      expect('firstName' in payload).toBe(false);
      expect('lastName' in payload).toBe(false);
      expect('phone' in payload).toBe(false);
      expect('phoneNumber' in payload).toBe(false);
    });

    it('emits only keys within the allowed non-PII set', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}));

      for (const key of Object.keys(capturedPayload())) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    });
  });

  // Build a real ConfigService backed by an internal config object so
  // getActiveSigningKid can be invoked type-safely (no casts).
  const buildKidConfigService = (keyId: string): ConfigService =>
    new ConfigService({ JWT_KEY_ID: keyId });

  // (B) audience + kid — SEC-HIGH-003.
  describe('audience + kid on signAsync (SEC-HIGH-003)', () => {
    it('defaults the audience to aquaculture-platform and stamps the active kid', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}));

      expect(signAsync).toHaveBeenCalledTimes(1);
      const signOptions = signAsync.mock.calls[0]?.[1] as {
        audience?: string;
        keyid?: string;
      };
      expect(signOptions.audience).toBe('aquaculture-platform');
      expect(signOptions.keyid).toBe('key-1'); // getActiveSigningKid default
    });

    it('honours the JWT_AUDIENCE override and JWT_KEY_ID', async () => {
      service = await createService({
        config: { JWT_AUDIENCE: 'custom-aud', JWT_KEY_ID: 'key-rotated-2' },
      });

      await service.generateTokens(buildUser({}));

      const signOptions = signAsync.mock.calls[0]?.[1] as {
        audience?: string;
        keyid?: string;
      };
      expect(signOptions.audience).toBe('custom-aud');
      // The kid is sourced from getActiveSigningKid(JWT_KEY_ID) — the same SSoT
      // the JWKS controller publishes — so the header always matches a
      // published JWKS entry. getActiveSigningKid(config) returns exactly the
      // JWT_KEY_ID value, asserted directly here.
      expect(signOptions.keyid).toBe('key-rotated-2');
      expect(getActiveSigningKid(buildKidConfigService('key-rotated-2'))).toBe(
        signOptions.keyid,
      );
    });
  });

  // (C) type discriminator.
  describe('token type discriminator', () => {
    it('stamps type === access on every mint', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}));

      expect(capturedPayload().type).toBe('access');
    });
  });

  // (D) getUserResourcePermissions — auth-schema tenant-scoped repoint + fail-loud.
  describe('getUserResourcePermissions (auth.* tenant-scoped + PERF-HIGH-001 fail-loud)', () => {
    it('queries centralized auth.* with NO per-tenant schema interpolation (crafted tenantId is bound, not concatenated)', async () => {
      // Post-1800500000000 the role tables live in `auth`; tenantId is a bound
      // parameter ($2), so even a malformed value can never reach a schema name
      // or the SQL text.
      const malicious = 'zz; DROP TABLE users;----------------';
      service = await createService({
        query: buildQueryRouter({ resourcePermissions: [] }),
      });

      await service.generateTokens(buildUser({ tenantId: malicious }));

      const roleJoinCall = query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('user_role_assignments') &&
          sql.includes('tenant_role_permissions'),
      );
      expect(roleJoinCall).toBeDefined();
      const [sql] = roleJoinCall as [string, unknown[]];
      expect(sql).toContain('"auth"."user_role_assignments"');
      expect(sql).not.toMatch(/"tenant_[a-f0-9]/); // no per-tenant schema interpolation
      expect(sql).not.toContain(malicious); // crafted value never reaches the SQL text
    });

    it('binds user.id ($1) + tenantId ($2) and tenant-scopes via auth.tenant_roles', async () => {
      service = await createService({
        query: buildQueryRouter({
          resourcePermissions: [{ resource_permissions: ['sites:view'] }],
        }),
      });

      await service.generateTokens(buildUser({}));

      const roleJoinCall = query.mock.calls.find(
        ([sql]) =>
          typeof sql === 'string' &&
          sql.includes('user_role_assignments') &&
          sql.includes('tenant_role_permissions'),
      );
      expect(roleJoinCall).toBeDefined();
      const [sql, params] = roleJoinCall as [string, unknown[]];
      // user.id + tenantId are bound, not interpolated; tenant isolation enforced.
      expect(sql).toContain('$1');
      expect(sql).toContain('tr."tenantId" = $2');
      expect(sql).not.toContain('11111111-1111-1111-1111-111111111111');
      expect(params).toEqual([
        '11111111-1111-1111-1111-111111111111',
        'abcdef01-2345-6789-abcd-ef0123456789',
      ]);
    });

    it('FAILS LOUD when the resource-permission query throws — never mints a zero-permission token', async () => {
      service = await createService({
        query: buildQueryRouter({
          onResourceQuery: () => Promise.reject(new Error('relation does not exist')),
        }),
      });

      await expect(service.generateTokens(buildUser({}))).rejects.toThrow(
        /relation does not exist/,
      );
      // A failed permission read must abort the mint, not sign a token.
      expect(signAsync).not.toHaveBeenCalled();
    });
  });

  // (E) module LRU eviction + TTL.
  describe('module LRU cache (eviction + TTL)', () => {
    it('caps the module cache at 5000 entries and re-queries the evicted oldest user', async () => {
      // tenant_modules JOIN drives the module read for TENANT_ADMIN users.
      const moduleQuery = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM auth.tenants')) {
          return Promise.resolve([{ plan: 'professional' }]);
        }
        return Promise.resolve([]); // tenant_modules → empty
      });
      service = await createService({ query: moduleQuery });

      const userId = (n: number): string =>
        `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

      // Prime the oldest user, then fill to capacity + 1 to evict it.
      const oldest = buildUser({
        id: userId(0),
        role: Role.TENANT_ADMIN,
        tenantId: VALID_TENANT_ID,
      });
      await service.getUserModules(oldest);

      for (let i = 1; i <= 5000; i++) {
        await service.getUserModules(
          buildUser({ id: userId(i), role: Role.TENANT_ADMIN, tenantId: VALID_TENANT_ID }),
        );
      }

      const tenantModuleQueriesBefore = moduleQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('auth.tenant_modules'),
      ).length;

      // The oldest user was evicted, so a second lookup re-queries.
      await service.getUserModules(oldest);

      const tenantModuleQueriesAfter = moduleQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('auth.tenant_modules'),
      ).length;

      expect(tenantModuleQueriesAfter).toBe(tenantModuleQueriesBefore + 1);
    });

    it('serves from cache within the TTL and re-queries after it expires', async () => {
      const nowSpy = jest.spyOn(Date, 'now');
      let clock = 1_000_000;
      nowSpy.mockImplementation(() => clock);

      const moduleQuery = jest.fn((sql: string) => {
        if (typeof sql === 'string' && sql.includes('FROM auth.tenants')) {
          return Promise.resolve([{ plan: 'professional' }]);
        }
        return Promise.resolve([]);
      });
      service = await createService({ query: moduleQuery });

      const user = buildUser({ role: Role.TENANT_ADMIN, tenantId: VALID_TENANT_ID });

      await service.getUserModules(user);
      const after1 = moduleQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('auth.tenant_modules'),
      ).length;

      // Within 60s TTL → served from cache, no new query.
      clock += 30_000;
      await service.getUserModules(user);
      const after2 = moduleQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('auth.tenant_modules'),
      ).length;
      expect(after2).toBe(after1);

      // Past 60s TTL → stale, re-query.
      clock += 61_000;
      await service.getUserModules(user);
      const after3 = moduleQuery.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('auth.tenant_modules'),
      ).length;
      expect(after3).toBe(after1 + 1);
    });
  });

  // (F) omit-when-empty shaping.
  describe('omit-when-empty modules / resourcePermissions', () => {
    it('absents the modules and resourcePermissions keys (not []) when reads are empty', async () => {
      service = await createService({
        query: buildQueryRouter({ resourcePermissions: [] }),
      });

      await service.generateTokens(buildUser({}));

      const payload = capturedPayload();
      expect('modules' in payload).toBe(false);
      expect('resourcePermissions' in payload).toBe(false);
    });

    it('includes resourcePermissions when the JOIN returns rows', async () => {
      service = await createService({
        query: buildQueryRouter({
          resourcePermissions: [{ resource_permissions: ['sites:view', 'tanks:edit'] }],
        }),
      });

      await service.generateTokens(buildUser({}));

      expect(capturedPayload().resourcePermissions).toEqual(
        expect.arrayContaining(['sites:view', 'tanks:edit']),
      );
    });
  });

  // (G) SessionManager path.
  describe('SessionManager path', () => {
    it('enforces the session limit and creates a session with tenant context', async () => {
      service = await createService({ config: { MAX_SESSIONS_PER_USER: 3 } });

      const user = buildUser({});
      await service.generateTokens(user, '203.0.113.5', 'jest-agent');

      expect(enforceSessionLimit).toHaveBeenCalledWith(user.id, 3);
      expect(createSession).toHaveBeenCalledWith(user.id, {
        ipAddress: '203.0.113.5',
        userAgent: 'jest-agent',
        tenantId: VALID_TENANT_ID,
      });
    });
  });

  // HASH_REFRESH_TOKENS=true exercises the bcrypt + userId-prefixed refresh path.
  describe('refresh-token hashing (HASH_REFRESH_TOKENS=true)', () => {
    it('hashes the stored token and returns the userId-prefixed plaintext', async () => {
      mockBcryptHash.mockResolvedValue('bcrypt-hash');
      service = await createService({ config: { HASH_REFRESH_TOKENS: true } });

      const user = buildUser({});
      const result = await service.generateTokens(user);

      expect(mockBcryptHash).toHaveBeenCalledTimes(1);
      // Stored value is the bcrypt hash, transported value is userId-prefixed.
      const savedRow = refreshSave.mock.calls[0]?.[0] as { token: string };
      expect(savedRow.token).toBe('bcrypt-hash');
      expect(result.refreshToken.startsWith(`${user.id}:`)).toBe(true);
    });
  });

  // mfaVerified stamping is conditional.
  describe('mfaVerified claim', () => {
    it('stamps mfaVerified=true only when the option is set', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}), undefined, undefined, {
        mfaVerified: true,
      });
      expect(capturedPayload().mfaVerified).toBe(true);
    });

    it('omits mfaVerified when the option is absent', async () => {
      service = await createService();

      await service.generateTokens(buildUser({}));
      expect('mfaVerified' in capturedPayload()).toBe(false);
    });
  });

  // ORPHAN-LOW-135: the refresh-token row records the rememberMe choice and
  // extends its own expiresAt to the remember-me TTL so a persistent cookie
  // never outlives the row it points at.
  describe('rememberMe persistence (ORPHAN-LOW-135)', () => {
    const daysFromNow = (d: Date): number => (d.getTime() - Date.now()) / (24 * 60 * 60 * 1000);

    it('persists rememberMe=true, extends expiresAt to the remember-me TTL, and returns it', async () => {
      service = await createService({
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      const result = await service.generateTokens(buildUser({}), undefined, undefined, {
        rememberMe: true,
      });

      const savedRow = refreshSave.mock.calls[0]?.[0] as { rememberMe: boolean; expiresAt: Date };
      expect(savedRow.rememberMe).toBe(true);
      expect(daysFromNow(savedRow.expiresAt)).toBeGreaterThan(29);
      expect(daysFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(30);
      expect(result.rememberMe).toBe(true);
    });

    it('defaults rememberMe=false and uses the default TTL when not remembered', async () => {
      service = await createService({
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      const result = await service.generateTokens(buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { rememberMe: boolean; expiresAt: Date };
      expect(savedRow.rememberMe).toBe(false);
      expect(daysFromNow(savedRow.expiresAt)).toBeGreaterThan(6);
      expect(daysFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(7);
      expect(result.rememberMe).toBe(false);
    });
  });
});

describe('TokenService — assignedSiteIds + mobileFeatures claims (SEC-HIGH-051/052)', () => {
  let service: TokenService;
  let signAsync: jest.Mock;
  let lastPayload: JwtPayload | undefined;
  let siteFind: jest.Mock;
  let getByUserId: jest.Mock;

  const TENANT = '22222222-2222-2222-2222-222222222222';
  const USER = '11111111-1111-1111-1111-111111111111';

  const capturedPayload = (): JwtPayload => {
    expect(signAsync).toHaveBeenCalledTimes(1);
    if (!lastPayload) {
      throw new Error('signAsync was not called with a payload');
    }
    return lastPayload;
  };

  const buildUser = (overrides: Partial<User>): User =>
    Object.assign(new User(), {
      id: USER,
      role: Role.MODULE_USER,
      tenantId: TENANT,
      ...overrides,
    });

  const buildService = async (): Promise<TokenService> => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn((x: unknown) => x), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: getRepositoryToken(UserSiteAssignment),
          useValue: { find: siteFind },
        },
        { provide: MobileSettingsService, useValue: { getByUserId } },
        { provide: DataSource, useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: JwtService, useValue: { signAsync } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) =>
              key === 'HASH_REFRESH_TOKENS' ? false : def,
            ),
          },
        },
      ],
    }).compile();
    return module.get<TokenService>(TokenService);
  };

  beforeEach(() => {
    lastPayload = undefined;
    signAsync = jest.fn((payload: JwtPayload) => {
      lastPayload = payload;
      return Promise.resolve('signed.access.token');
    });
    // Active non-expired site assignment by default.
    siteFind = jest.fn().mockResolvedValue([
      { siteId: 'site-a', isActive: true, isAccessible: () => true },
      { siteId: 'site-b', isActive: true, isAccessible: () => true },
    ]);
    getByUserId = jest.fn().mockResolvedValue({
      isMobileEnabled: true,
      allowedFeatures: { mortality: true, harvest: true, cull: false, leave: true },
    });
  });

  it('stamps assignedSiteIds from active, non-expired assignments for a MODULE_USER', async () => {
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect(capturedPayload().assignedSiteIds).toEqual(['site-a', 'site-b']);
  });

  it('projects ONLY the truthy allowedFeatures keys into mobileFeatures (single read path)', async () => {
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    const features = capturedPayload().mobileFeatures ?? [];
    expect(features.sort()).toEqual(['harvest', 'leave', 'mortality']);
    // cull=false must NOT appear.
    expect(features).not.toContain('cull');
    // MobileSettingsService is the SINGLE read path.
    expect(getByUserId).toHaveBeenCalledWith(USER, TENANT);
  });

  it('omits mobileFeatures when mobile is disabled', async () => {
    getByUserId.mockResolvedValue({ isMobileEnabled: false, allowedFeatures: { mortality: true } });
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect('mobileFeatures' in capturedPayload()).toBe(false);
  });

  it('omits assignedSiteIds when the user has no active assignments', async () => {
    siteFind.mockResolvedValue([]);
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect('assignedSiteIds' in capturedPayload()).toBe(false);
  });

  it('omits assignedSiteIds for TENANT_ADMIN (they bypass via the role hierarchy)', async () => {
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    // TENANT_ADMIN never queries the site assignment repo.
    expect(siteFind).not.toHaveBeenCalled();
    expect('assignedSiteIds' in capturedPayload()).toBe(false);
  });

  it('signs with the keyid header SSoT untouched (no RS256/JWKS change)', async () => {
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    // The signing call must still pass keyid + audience — adding claims to the
    // payload must not have altered the signing options path.
    expect(signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access' }),
      expect.objectContaining({ keyid: expect.anything() }),
    );
  });
});
