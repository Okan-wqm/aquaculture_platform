import { generateKeyPairSync } from 'node:crypto';
import { getActiveSigningKid } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  ISessionManager,
  IUserTokenRevocation,
  SESSION_MANAGER,
  TOKEN_BLACKLIST,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

import { LockedAuthContext, snapshotCredentialProof } from './credential-state';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import { GenerateTokensOptions, JwtPayload, TokenService } from './token.service';

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
  const promiseHash: (data: string, saltOrRounds: string | number) => Promise<string> = actual.hash;
  return { ...actual, hash: jest.fn(promiseHash) };
});

// Typed alias over the spy-able wrapper above. The explicit type argument
// selects hash's promise overload; jest.mocked over the raw overloaded type
// would collapse mockResolvedValue to never.
const mockBcryptHash = jest.mocked<
  (data: string, saltOrRounds: string | number) => Promise<string>
>(bcrypt.hash);

function makeUserTokenRevocation(
  isTokenValid = jest.fn().mockResolvedValue(true),
): IUserTokenRevocation {
  return {
    revokeUserTokens: jest.fn().mockResolvedValue(undefined),
    isTokenValid,
  };
}

interface SiteAssignmentQueryBuilderDouble {
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  setLock: jest.Mock;
  getMany: jest.Mock;
}

interface SiteAssignmentRepositoryDouble {
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeSiteAssignmentRepository(find: jest.Mock): {
  repository: SiteAssignmentRepositoryDouble;
  queryBuilder: SiteAssignmentQueryBuilderDouble;
} {
  const queryBuilder: SiteAssignmentQueryBuilderDouble = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    setLock: jest.fn(),
    getMany: find,
  };
  queryBuilder.where.mockReturnValue(queryBuilder);
  queryBuilder.andWhere.mockReturnValue(queryBuilder);
  queryBuilder.orderBy.mockReturnValue(queryBuilder);
  queryBuilder.setLock.mockReturnValue(queryBuilder);

  return {
    repository: {
      find,
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    },
    queryBuilder,
  };
}

let principalForMint: User;

async function mint(
  service: TokenService,
  user: User,
  ipAddress?: string,
  userAgent?: string,
  options?: GenerateTokensOptions,
): Promise<Awaited<ReturnType<TokenService['generateTokens']>>> {
  principalForMint = Object.assign(user, {
    isActive: user.isActive ?? true,
    credentialVersion: user.credentialVersion ?? 1,
    accessTokenInvalidBeforeEpochSeconds: user.accessTokenInvalidBeforeEpochSeconds ?? 0,
  });
  return service.generateTokens(snapshotCredentialProof(user), ipAddress, userAgent, options);
}

function makeTransactionalDataSource(query: jest.Mock): {
  dataSource: object;
  userRepository: { findOne: jest.Mock };
  lockedUserFindOne: jest.Mock;
  transaction: jest.Mock;
  manager: EntityManager;
} {
  const source = new DataSource({ type: 'postgres' });
  const queryRunner = source.createQueryRunner();
  jest.replaceProperty(queryRunner, 'isTransactionActive', true);
  const manager = queryRunner.manager;
  const lockedUserFindOne = jest.fn().mockImplementation(() => Promise.resolve(principalForMint));
  jest.spyOn(manager, 'findOne').mockImplementation(async (entity, options) => {
    if (entity === Tenant)
      return Object.assign(new Tenant(), {
        id: principalForMint.tenantId,
        status: TenantStatus.ACTIVE,
      });
    if (entity !== User) throw new Error('Unexpected identity entity');
    if (options.lock) return lockedUserFindOne(options);
    return principalForMint;
  });
  jest.spyOn(manager, 'query').mockImplementation(query);
  jest.spyOn(manager, 'withRepository').mockImplementation((repository) => repository);
  const transaction = jest.fn((work: (transactionManager: EntityManager) => Promise<unknown>) =>
    work(manager),
  );
  return {
    dataSource: { query, transaction, manager },
    userRepository: { findOne: lockedUserFindOne },
    lockedUserFindOne,
    transaction,
    manager,
  };
}

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
    const transactionHarness = makeTransactionalDataSource(query);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: TOKEN_BLACKLIST,
          useValue: { isBlacklisted: jest.fn().mockResolvedValue(false), add: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: transactionHarness.userRepository,
        },
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
          useValue: {
            getByUserId: jest
              .fn()
              .mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }),
          },
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: { create: jest.fn((x: unknown) => x), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(UserModuleAssignment),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: DataSource, useValue: transactionHarness.dataSource },
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
        { provide: USER_TOKEN_REVOCATION, useValue: makeUserTokenRevocation() },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  it('includes the tenant plan ordinal as planLevel', async () => {
    await mint(service, buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(2); // professional → PLAN_LEVEL 2
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM auth.tenants'), [
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  it('omits planLevel for a platform account with no tenant', async () => {
    await mint(service, buildUser({ role: Role.SUPER_ADMIN, tenantId: null }));

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

    await mint(service, buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(0);
  });

  // C1 (tenant-isolation invariant): SUPER_ADMIN is the only tenantless role.
  it('rejects issuing a token to a non-SUPER_ADMIN principal with no tenant', async () => {
    await expect(
      mint(service, buildUser({ role: Role.MODULE_USER, tenantId: null })),
    ).rejects.toThrow('Authentication failed');
  });

  it('rejects a tenant-scoped TENANT_ADMIN whose tenant resolves to null', async () => {
    await expect(
      mint(service, buildUser({ role: Role.TENANT_ADMIN, tenantId: null })),
    ).rejects.toThrow('Authentication failed');
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
 *   (E) authoritative authorization reads on every mint
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
  let isTokenValid: jest.Mock;
  let siteSnapshotTransaction: jest.Mock;
  let credentialUserLockFindOne: jest.Mock;
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
    resourcePermissions?: Array<{
      resource_permissions: string[] | null;
      permission_overrides?: unknown;
    }>;
    plan?: string;
    onResourceQuery?: (sql: string) => Promise<unknown>;
    // RBAC-HIGH-010: the tenant's ENABLED module codes for the entitlement
    // intersection. Default 'farm' keeps core caps entitled; add 'ai'/'hr' to
    // license those module-gated categories.
    enabledModuleCodes?: string[];
  }): jest.Mock =>
    jest.fn((sql: string) => {
      if (typeof sql !== 'string') {
        return Promise.resolve([]);
      }
      // Entitlement query (RBAC-HIGH-010): tenant_modules JOIN modules.
      if (sql.includes('tenant_modules') && sql.includes('"auth"."modules"')) {
        const codes = overrides?.enabledModuleCodes ?? ['farm'];
        return Promise.resolve(codes.map((code) => ({ code })));
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
    jwtService?: JwtService;
  }): Promise<TokenService> => {
    configValues = { HASH_REFRESH_TOKENS: false, ...(deps?.config ?? {}) };
    query = deps?.query ?? buildQueryRouter();
    const siteAssignments = makeSiteAssignmentRepository(jest.fn().mockResolvedValue([]));
    const transactionHarness = makeTransactionalDataSource(query);
    const { dataSource } = transactionHarness;
    siteSnapshotTransaction = transactionHarness.transaction;
    credentialUserLockFindOne = transactionHarness.lockedUserFindOne;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: TOKEN_BLACKLIST,
          useValue: { isBlacklisted: jest.fn().mockResolvedValue(false), add: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: transactionHarness.userRepository,
        },
        // SEC-HIGH-051/052: TokenService now requires the site-assignment repo +
        // mobile-settings read path. Empty defaults keep this suite's claims
        // (assignedSiteIds/mobileFeatures) absent — they assert the OTHER claims.
        {
          provide: getRepositoryToken(UserSiteAssignment),
          useValue: siteAssignments.repository,
        },
        {
          provide: MobileSettingsService,
          // getByUserId NEVER returns null (it creates a default row); a DISABLED
          // settings object yields empty mobileFeatures, keeping this suite's claims absent.
          useValue: {
            getByUserId: jest
              .fn()
              .mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }),
          },
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
        { provide: DataSource, useValue: dataSource },
        { provide: JwtService, useValue: deps?.jwtService ?? { signAsync } },
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
        {
          provide: USER_TOKEN_REVOCATION,
          useValue: makeUserTokenRevocation(isTokenValid),
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
    isTokenValid = jest.fn().mockResolvedValue(true);
  });

  // Prevent the shared signAsync/query/bcrypt mocks from bleeding across blocks
  // (ties to AUDIT-MEDIUM-015 — deterministic, isolated specs). restoreAllMocks
  // restores any jest.spyOn (e.g. Date.now); clearAllMocks wipes call history;
  // the bcrypt hash wrapper's per-test implementation is reset explicitly so it
  // falls back to the real hash for blocks that do not stub it.
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.useRealTimers();
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
      'iat',
      'exp',
      'mfaVerified',
    ]);

    it('carries no email / firstName / lastName / phone in the payload', async () => {
      service = await createService();

      await mint(service, buildUser({}));

      const payload = capturedPayload();
      expect('email' in payload).toBe(false);
      expect('firstName' in payload).toBe(false);
      expect('lastName' in payload).toBe(false);
      expect('phone' in payload).toBe(false);
      expect('phoneNumber' in payload).toBe(false);
    });

    it('emits only keys within the allowed non-PII set', async () => {
      service = await createService();

      await mint(service, buildUser({}));

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

      await mint(service, buildUser({}));

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

      await mint(service, buildUser({}));

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
      expect(getActiveSigningKid(buildKidConfigService('key-rotated-2'))).toBe(signOptions.keyid);
    });
  });

  // (C) type discriminator.
  describe('token type discriminator', () => {
    it('stamps type === access on every mint', async () => {
      service = await createService();

      await mint(service, buildUser({}));

      expect(capturedPayload().type).toBe('access');
    });
  });

  // (D) getUserResourcePermissions — auth-schema tenant-scoped repoint + fail-loud.
  describe('getUserResourcePermissions (auth.* tenant-scoped + PERF-HIGH-001 fail-loud)', () => {
    it('queries centralized auth.* with NO per-tenant schema interpolation (crafted tenantId is bound, not concatenated)', async () => {
      // Post admin-api `1800500000000-TenantProvisioningTopology` the role
      // tables live in `auth`; tenantId is a bound parameter ($2), so even a
      // malformed value can never reach a schema name or the SQL text.
      const malicious = 'zz; DROP TABLE users;----------------';
      service = await createService({
        query: buildQueryRouter({ resourcePermissions: [] }),
      });

      await mint(service, buildUser({ tenantId: malicious }));

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

      await mint(service, buildUser({}));

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

      await expect(mint(service, buildUser({}))).rejects.toThrow(/relation does not exist/);
      // A failed permission read must abort the mint, not sign a token.
      expect(signAsync).not.toHaveBeenCalled();
    });
  });

  // (E) Authorization claims are authoritative on every mint. There is no
  // process-local cache whose stale contents can survive an administrator's
  // module or permission reduction on the next refresh.
  describe('authoritative authorization reads on every mint', () => {
    it('sees a changed module assignment on the immediately following mint', async () => {
      const moduleAssignmentFind = jest
        .fn()
        .mockResolvedValueOnce([
          {
            isAccessible: () => true,
            module: { code: 'farm', name: 'Farm', defaultRoute: '/farm' },
          },
        ])
        .mockResolvedValueOnce([
          {
            isAccessible: () => true,
            module: { code: 'sensor', name: 'Sensor', defaultRoute: '/sensor' },
          },
        ]);
      service = await createService({ moduleAssignmentFind });
      const user = buildUser({});

      await mint(service, user);
      expect(capturedPayload().modules).toEqual(['farm']);

      await mint(service, user);
      expect(capturedPayload().modules).toEqual(['sensor']);
      expect(moduleAssignmentFind).toHaveBeenCalledTimes(2);
    });

    it('sees changed role permissions on the immediately following mint', async () => {
      const permissionReads: Array<Array<{ resource_permissions: string[] }>> = [
        [{ resource_permissions: ['sites:view'] }],
        [{ resource_permissions: ['sites:edit'] }],
      ];
      service = await createService({
        query: buildQueryRouter({
          onResourceQuery: () => Promise.resolve(permissionReads.shift() ?? []),
        }),
      });
      const user = buildUser({});

      await mint(service, user);
      expect(capturedPayload().resourcePermissions).toEqual(['sites:view']);

      await mint(service, user);
      expect(capturedPayload().resourcePermissions).toEqual(['sites:edit']);
      expect(permissionReads).toHaveLength(0);
    });
  });

  // (F) omit-when-empty shaping.
  describe('omit-when-empty modules / resourcePermissions', () => {
    it('absents the modules and resourcePermissions keys (not []) when reads are empty', async () => {
      service = await createService({
        query: buildQueryRouter({ resourcePermissions: [] }),
      });

      await mint(service, buildUser({}));

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

      await mint(service, buildUser({}));

      expect(capturedPayload().resourcePermissions).toEqual(
        expect.arrayContaining(['sites:view', 'tanks:edit']),
      );
    });

    it('folds per-user permission_overrides (revoke then grant) into the resourcePermissions claim', async () => {
      // Role base = {sites:view, sites:edit}; the assignment revokes sites:edit
      // and grants roles:view. Proves overrides reach the JWT end-to-end — before
      // this fold they were never selected here, so a per-user grant/revoke had
      // zero runtime effect (the guard enforced only the role's base set).
      service = await createService({
        query: buildQueryRouter({
          resourcePermissions: [
            {
              resource_permissions: ['sites:view', 'sites:edit'],
              permission_overrides: { grants: ['roles:view'], revokes: ['sites:edit'] },
            },
          ],
        }),
      });

      await mint(service, buildUser({}));

      const claim = capturedPayload().resourcePermissions ?? [];
      expect(claim).toEqual(expect.arrayContaining(['sites:view', 'roles:view']));
      expect(claim).not.toContain('sites:edit');
    });

    // RBAC-HIGH-010: the mint intersects effective permissions with the tenant's
    // LICENSED capability set, so a stored grant for an unlicensed module (a
    // stale grant after a plan downgrade, or the MT-HIGH-057 backfill that
    // seeded ai_/messaging caps onto every default role) never reaches the JWT.
    it('drops a stored capability for a module the tenant does NOT license (entitlement intersection)', async () => {
      service = await createService({
        query: buildQueryRouter({
          // The role stores a core cap AND an AI cap...
          resourcePermissions: [{ resource_permissions: ['sites:view', 'ai_settings:manage'] }],
          // ...but the tenant only licenses the farm module.
          enabledModuleCodes: ['farm'],
        }),
      });

      await mint(service, buildUser({}));

      const claim = capturedPayload().resourcePermissions ?? [];
      expect(claim).toContain('sites:view'); // core survives
      expect(claim).not.toContain('ai_settings:manage'); // unlicensed dropped
    });

    it('keeps the module-gated capability once the tenant licenses that module', async () => {
      service = await createService({
        query: buildQueryRouter({
          resourcePermissions: [{ resource_permissions: ['sites:view', 'ai_settings:manage'] }],
          enabledModuleCodes: ['farm', 'ai'],
        }),
      });

      await mint(service, buildUser({}));

      const claim = capturedPayload().resourcePermissions ?? [];
      expect(claim).toEqual(expect.arrayContaining(['sites:view', 'ai_settings:manage']));
    });
  });

  describe('authorization-revocation issuance fence', () => {
    it('cannot insert a refresh token while deactivation owns the User fence and fails stale issuance closed', async () => {
      service = await createService();
      const authenticatedAt = new Date('2026-08-01T12:00:00.000Z');
      const authenticatedSnapshot = buildUser({ updatedAt: authenticatedAt });
      let finishCredentialFence: ((lockedUser: { id: string } | null) => void) | undefined;
      credentialUserLockFindOne.mockImplementationOnce(
        () =>
          new Promise<{ id: string } | null>((resolve) => {
            finishCredentialFence = resolve;
          }),
      );

      const pendingMint = mint(service, authenticatedSnapshot);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();

      expect(refreshSave).not.toHaveBeenCalled();
      expect(signAsync).not.toHaveBeenCalled();
      if (!finishCredentialFence) {
        throw new Error('Credential-fence test gate was not initialized');
      }

      // A concurrent administrator committed deactivation/password mutation
      // while this login waited. The authoritative snapshot predicate no
      // longer resolves, so stale authentication cannot mint a replacement.
      finishCredentialFence(null);
      await expect(pendingMint).rejects.toThrow('User credentials changed during authentication');

      expect(credentialUserLockFindOne).toHaveBeenCalledWith({
        where: { id: authenticatedSnapshot.id },
        lock: { mode: 'pessimistic_write' },
      });
      expect(refreshSave).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('waits for the real next clock second and performs two authoritative revocation reads', async () => {
      const currentSecond = Date.parse('2026-08-01T12:00:00.000Z');
      jest.useFakeTimers({ now: currentSecond + 900 });
      isTokenValid.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      service = await createService();

      const mintPromise = mint(service, buildUser({}));
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(101);
      await mintPromise;

      expect(isTokenValid).toHaveBeenCalledTimes(2);
      expect(isTokenValid).toHaveBeenNthCalledWith(
        1,
        '11111111-1111-1111-1111-111111111111',
        new Date(currentSecond),
      );
      expect(isTokenValid).toHaveBeenNthCalledWith(
        2,
        '11111111-1111-1111-1111-111111111111',
        new Date(currentSecond + 1_000),
      );
      expect(capturedPayload().iat).toBe(currentSecond / 1_000 + 1);
    });
  });

  // (G) SessionManager path.
  describe('SessionManager path', () => {
    it('uses durable refresh families without an independent Redis session write', async () => {
      service = await createService({ config: { MAX_SESSIONS_PER_USER: 3 } });

      const user = buildUser({});
      await mint(service, user, '203.0.113.5', 'jest-agent');

      expect(enforceSessionLimit).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(refreshSave).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          tenantId: VALID_TENANT_ID,
          familyId: expect.any(String),
        }),
      );
    });

    it('does not enforce or establish a session during refresh-token rotation', async () => {
      service = await createService({ config: { MAX_SESSIONS_PER_USER: 3 } });

      await mint(service, buildUser({}), undefined, undefined, {
        establishSession: false,
      });

      expect(enforceSessionLimit).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(refreshSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction-scoped refresh-token persistence', () => {
    it('uses the context manager for every claim read and refresh insertion', async () => {
      service = await createService();
      const principal = buildUser({ role: Role.MODULE_USER });
      principalForMint = Object.assign(principal, {
        credentialVersion: 1,
        accessTokenInvalidBeforeEpochSeconds: 0,
        isActive: true,
      });
      const query = buildQueryRouter();
      const harness = makeTransactionalDataSource(query);
      const context = await LockedAuthContext.lock(
        harness.manager,
        snapshotCredentialProof(principal),
      );
      const scopedSave = jest.fn().mockResolvedValue(undefined);
      const scopedRepository = Object.assign(
        new Repository<RefreshToken>(RefreshToken, harness.manager),
        {
          create: jest.fn((value: Partial<RefreshToken>) =>
            Object.assign(new RefreshToken(), value),
          ),
          save: scopedSave,
        },
      );
      const withRepository = jest.mocked(harness.manager.withRepository);
      withRepository.mockImplementation((repository) => {
        if (repository.save === refreshSave) return scopedRepository;
        return repository;
      });
      await service.generateTokensInContext(context, undefined, undefined, {
        establishSession: false,
        familyId: 'same-family',
      });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('user_role_assignments'), [
        principal.id,
        principal.tenantId,
      ]);
      expect(scopedSave).toHaveBeenCalledWith(expect.objectContaining({ familyId: 'same-family' }));
      expect(refreshSave).not.toHaveBeenCalled();
      expect(siteSnapshotTransaction).not.toHaveBeenCalled();
    });
  });

  describe('permanent credential-state admission', () => {
    it('evicts all history of the oldest active family before a new family is inserted', async () => {
      const router = buildQueryRouter();
      const query = jest.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('GROUP BY "familyId"'))
          return Promise.resolve([
            { familyId: 'old-family' },
            { familyId: 'second-family' },
            { familyId: 'third-family' },
          ]);
        return router(sql, params);
      });
      service = await createService({ query, config: { MAX_SESSIONS_PER_USER: 3 } });
      const user = buildUser({});
      await mint(service, user);
      const terminalWrites = query.mock.calls.filter(([sql]) =>
        String(sql).includes("'Session limit exceeded'"),
      );
      expect(terminalWrites).toHaveLength(1);
      expect(terminalWrites[0]?.[0]).not.toContain('"isRevoked" = false');
      expect(terminalWrites[0]?.[1]).toEqual([user.id, 'old-family']);
    });

    it('uses the durable DB cutoff even before its Redis outbox projection arrives', async () => {
      const now = Date.parse('2026-09-01T12:00:00.500Z');
      jest.useFakeTimers({ now });
      service = await createService();
      const promise = mint(
        service,
        buildUser({ accessTokenInvalidBeforeEpochSeconds: Math.floor(now / 1000) }),
      );
      await jest.advanceTimersByTimeAsync(501);
      await promise;
      expect(capturedPayload().iat).toBe(Math.floor(now / 1000) + 1);
    });

    it('does not mint through a context whose transaction has ended', async () => {
      service = await createService();
      principalForMint = Object.assign(buildUser({}), {
        credentialVersion: 1,
        accessTokenInvalidBeforeEpochSeconds: 0,
        isActive: true,
      });
      const harness = makeTransactionalDataSource(buildQueryRouter());
      const context = await LockedAuthContext.lock(
        harness.manager,
        snapshotCredentialProof(principalForMint),
      );
      if (!harness.manager.queryRunner) throw new Error('Missing test query runner');
      jest.replaceProperty(harness.manager.queryRunner, 'isTransactionActive', false);
      await expect(service.generateTokensInContext(context)).rejects.toThrow('active transaction');
      expect(refreshSave).not.toHaveBeenCalled();
    });

    it('signs RS256 access and step-up tokens with absolute expiry and retains revocation identity', async () => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      const jwt = new JwtService({
        privateKey,
        publicKey,
        signOptions: {
          algorithm: 'RS256',
          issuer: 'aquaculture-platform',
          audience: 'aquaculture-platform',
        },
      });
      service = await createService({
        jwtService: jwt,
        config: { JWT_PRIVATE_KEY: privateKey, JWT_PUBLIC_KEY: publicKey },
      });
      const user = buildUser({ role: Role.SUPER_ADMIN, tenantId: null });
      const initial = await mint(service, user);
      const initialPayload = await jwt.verifyAsync<JwtPayload>(initial.accessToken, {
        algorithms: ['RS256'],
      });
      if (!initialPayload.jti || !initialPayload.iat || !initialPayload.exp)
        throw new Error('Missing signed session identity');
      const harness = makeTransactionalDataSource(buildQueryRouter());
      const context = await LockedAuthContext.lock(harness.manager, snapshotCredentialProof(user));
      const initialInserts = refreshSave.mock.calls.length;
      const elevated = await service.generateStepUpInContext(context, {
        sub: user.id,
        role: user.role,
        tenantId: null,
        jti: initialPayload.jti,
        iat: initialPayload.iat,
        exp: initialPayload.exp,
      });
      const elevatedPayload = await jwt.verifyAsync<JwtPayload>(elevated.accessToken, {
        algorithms: ['RS256'],
      });
      expect(elevatedPayload).toMatchObject({
        jti: initialPayload.jti,
        iat: initialPayload.iat,
        mfaVerified: true,
      });
      expect(elevatedPayload.exp).toBeLessThanOrEqual(initialPayload.exp);
      expect(elevatedPayload.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
      expect(elevated.refreshToken).toBe('');
      expect(refreshSave).toHaveBeenCalledTimes(initialInserts);
    });
  });

  // HASH_REFRESH_TOKENS=true exercises the bcrypt + rolling-compatible V2
  // two-segment transport. The opaque secret embeds the indexed tokenId while
  // retaining the legacy `userId:secret` split consumed during rollout.
  describe('refresh-token hashing (HASH_REFRESH_TOKENS=true)', () => {
    it('joins refresh hashing before signing so hashing failure cannot leave a partially signed session', async () => {
      mockBcryptHash.mockRejectedValueOnce(new Error('hash unavailable'));
      service = await createService({ config: { HASH_REFRESH_TOKENS: true } });
      await expect(mint(service, buildUser({}))).rejects.toThrow('hash unavailable');
      expect(signAsync).not.toHaveBeenCalled();
      expect(refreshSave).not.toHaveBeenCalled();
    });

    it('stores tokenId + hash and returns exactly userId:secret with tokenId embedded', async () => {
      mockBcryptHash.mockResolvedValue('bcrypt-hash');
      service = await createService({ config: { HASH_REFRESH_TOKENS: true } });

      const user = buildUser({});
      const result = await mint(service, user);

      expect(mockBcryptHash).toHaveBeenCalledTimes(1);
      const savedRow = refreshSave.mock.calls[0]?.[0] as { token: string; tokenId: string };
      const segments = result.refreshToken.split(':');
      const transportedSecret = segments[1];

      expect(segments).toHaveLength(2);
      expect(segments[0]).toBe(user.id);
      expect(transportedSecret).toBeDefined();
      expect(savedRow.token).toBe('bcrypt-hash');
      expect(savedRow.tokenId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(transportedSecret?.startsWith(savedRow.tokenId.replaceAll('-', ''))).toBe(true);
      expect(mockBcryptHash).toHaveBeenCalledWith(transportedSecret, expect.any(Number));
    });
  });

  // mfaVerified stamping is conditional.
  describe('mfaVerified claim', () => {
    it('stamps mfaVerified=true only when the option is set', async () => {
      service = await createService();

      await mint(service, buildUser({}), undefined, undefined, {
        mfaVerified: true,
      });
      expect(capturedPayload().mfaVerified).toBe(true);
    });

    it('omits mfaVerified when the option is absent', async () => {
      service = await createService();

      await mint(service, buildUser({}));
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

      const result = await mint(service, buildUser({}), undefined, undefined, {
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

      const result = await mint(service, buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { rememberMe: boolean; expiresAt: Date };
      expect(savedRow.rememberMe).toBe(false);
      expect(daysFromNow(savedRow.expiresAt)).toBeGreaterThan(6);
      expect(daysFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(7);
      expect(result.rememberMe).toBe(false);
    });
  });

  // ADR-046 / ADMIN-HIGH-015 — the tenant idle-session policy clamps the
  // refresh-token TTL, and it does so INSIDE this chokepoint. These specs pin
  // both halves: the arithmetic, and the fact that no caller threads it.
  describe('tenant session-timeout clamp (ADR-046)', () => {
    const minutesFromNow = (d: Date): number => (d.getTime() - Date.now()) / 60_000;

    const routerWithPolicy = (sessionTimeoutMinutes: number | null): jest.Mock =>
      jest.fn((sql: string) => {
        if (typeof sql !== 'string') {
          return Promise.resolve([]);
        }
        if (sql.includes('tenant_modules') && sql.includes('"auth"."modules"')) {
          return Promise.resolve([{ code: 'farm' }]);
        }
        if (sql.includes('user_role_assignments') && sql.includes('tenant_role_permissions')) {
          return Promise.resolve([]);
        }
        if (sql.includes('FROM auth.tenants')) {
          return Promise.resolve([
            { plan: 'professional', session_timeout_minutes: sessionTimeoutMinutes },
          ]);
        }
        return Promise.resolve([]);
      });

    it('reads the policy in the SAME auth.tenants statement as the plan claim', async () => {
      service = await createService({ query: routerWithPolicy(60) });

      await mint(service, buildUser({}));

      const tenantReads = query.mock.calls
        .map((call) => call[0] as unknown)
        .filter(
          (sql): sql is string => typeof sql === 'string' && sql.includes('FROM auth.tenants'),
        );
      expect(tenantReads).toHaveLength(1);
      expect(tenantReads[0]).toContain('session_timeout_minutes');
      // The plan claim still resolves off the same row — no second read.
      expect(capturedPayload().planLevel).toBeDefined();
    });

    it('clamps the refresh TTL to the tenant policy when it is shorter', async () => {
      service = await createService({
        query: routerWithPolicy(30),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      await mint(service, buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      expect(minutesFromNow(savedRow.expiresAt)).toBeGreaterThan(29);
      expect(minutesFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(30);
    });

    it('lets the tenant policy win over a rememberMe extension', async () => {
      service = await createService({
        query: routerWithPolicy(45),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      const result = await mint(service, buildUser({}), undefined, undefined, {
        rememberMe: true,
      });

      const savedRow = refreshSave.mock.calls[0]?.[0] as { rememberMe: boolean; expiresAt: Date };
      // The remembered flag is preserved (the cookie stays persistent) but the
      // ROW cannot outlive the tenant's idle window.
      expect(savedRow.rememberMe).toBe(true);
      expect(result.rememberMe).toBe(true);
      expect(minutesFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(45);
    });

    it('keeps the configured TTL when the tenant sets no policy (NULL)', async () => {
      service = await createService({
        query: routerWithPolicy(null),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      await mint(service, buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      expect(minutesFromNow(savedRow.expiresAt)).toBeGreaterThan(7 * 24 * 60 - 1);
    });

    it('never lets a longer tenant policy EXTEND the configured TTL', async () => {
      service = await createService({
        query: routerWithPolicy(1440),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 0.5, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      await mint(service, buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      // MIN wins: 0.5 day (720 min) is shorter than the 1440-minute policy.
      expect(minutesFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(720);
    });

    it('exposes NO caller-supplied session-timeout parameter (the clamp cannot be forgotten)', () => {
      // ADMIN-HIGH-015 root cause: the clamp used to be an optional argument
      // five of seven mint paths omitted. Pin that generateTokens takes exactly
      // (user, ipAddress, userAgent, options) and that the options bag carries
      // no timeout knob — a caller has nothing to pass and nothing to forget.
      expect(TokenService.prototype.generateTokens).toHaveLength(3);
      const source = TokenService.prototype.generateTokens.toString();
      expect(source).not.toMatch(/sessionTimeout/i);
    });
  });
});

describe('TokenService — assignedSiteIds + mobileFeatures claims (SEC-HIGH-051/052)', () => {
  let service: TokenService;
  let signAsync: jest.Mock;
  let lastPayload: JwtPayload | undefined;
  let siteFind: jest.Mock;
  let siteQueryBuilder: SiteAssignmentQueryBuilderDouble;
  let lockedUserFindOne: jest.Mock;
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
    const siteAssignments = makeSiteAssignmentRepository(siteFind);
    siteQueryBuilder = siteAssignments.queryBuilder;
    const query = jest.fn().mockResolvedValue([]);
    const transactionHarness = makeTransactionalDataSource(query);
    lockedUserFindOne = transactionHarness.lockedUserFindOne;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: TOKEN_BLACKLIST,
          useValue: { isBlacklisted: jest.fn().mockResolvedValue(false), add: jest.fn() },
        },
        {
          provide: getRepositoryToken(User),
          useValue: transactionHarness.userRepository,
        },
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
          useValue: siteAssignments.repository,
        },
        { provide: MobileSettingsService, useValue: { getByUserId } },
        { provide: DataSource, useValue: transactionHarness.dataSource },
        { provide: JwtService, useValue: { signAsync } },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def?: unknown) =>
              key === 'HASH_REFRESH_TOKENS' ? false : def,
            ),
          },
        },
        { provide: USER_TOKEN_REVOCATION, useValue: makeUserTokenRevocation() },
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
      { siteId: 'site-a', isActive: true, expiresAt: null },
      { siteId: 'site-b', isActive: true, expiresAt: null },
    ]);
    getByUserId = jest.fn().mockResolvedValue({
      isMobileEnabled: true,
      allowedFeatures: { mortality: true, harvest: true, cull: false, leave: true },
    });
  });

  it('stamps assignedSiteIds from active, non-expired assignments for a MODULE_USER', async () => {
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_USER }));

    expect(capturedPayload().assignedSiteIds).toEqual(['site-a', 'site-b']);
    expect(lockedUserFindOne).toHaveBeenCalledWith({
      where: { id: USER },
      lock: { mode: 'pessimistic_write' },
    });
    expect(siteQueryBuilder.where).toHaveBeenCalledWith('assignment.userId = :userId', {
      userId: USER,
    });
    expect(siteQueryBuilder.andWhere).toHaveBeenCalledWith('assignment.tenantId = :tenantId', {
      tenantId: TENANT,
    });
    expect(siteQueryBuilder.setLock).toHaveBeenCalledWith('pessimistic_read');
  });

  it('caps access-token TTL to the canonical earliest assignment expiry', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    siteFind.mockResolvedValue([
      { siteId: 'site-long', isActive: true, expiresAt: new Date(now + 300_000) },
      { siteId: 'site-short', isActive: true, expiresAt: new Date(now + 120_000) },
    ]);
    service = await buildService();

    const result = await mint(service, buildUser({ role: Role.MODULE_USER }));

    expect(capturedPayload().assignedSiteIds).toEqual(['site-long', 'site-short']);
    expect(signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ iat: now / 1000, exp: now / 1000 + 120 }),
      expect.not.objectContaining({ expiresIn: expect.anything() }),
    );
    expect(result.expiresIn).toBe(120);
    dateNow.mockRestore();
  });

  it('excludes an assignment at the exact canonical expiry boundary', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z');
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(now);
    siteFind.mockResolvedValue([
      { siteId: 'site-boundary', isActive: true, expiresAt: new Date(now + 999) },
    ]);
    service = await buildService();

    await mint(service, buildUser({ role: Role.MODULE_USER }));

    expect('assignedSiteIds' in capturedPayload()).toBe(false);
    dateNow.mockRestore();
  });

  it('projects ONLY the truthy allowedFeatures keys into mobileFeatures (single read path)', async () => {
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_USER }));

    const features = capturedPayload().mobileFeatures ?? [];
    expect(features.sort()).toEqual(['harvest', 'leave', 'mortality']);
    // cull=false must NOT appear.
    expect(features).not.toContain('cull');
    // MobileSettingsService is the SINGLE read path.
    expect(getByUserId).toHaveBeenCalledWith(USER, TENANT, expect.any(EntityManager));
  });

  it('omits mobileFeatures when mobile is disabled', async () => {
    getByUserId.mockResolvedValue({ isMobileEnabled: false, allowedFeatures: { mortality: true } });
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_USER }));

    expect('mobileFeatures' in capturedPayload()).toBe(false);
  });

  it('omits assignedSiteIds when the user has no active assignments', async () => {
    siteFind.mockResolvedValue([]);
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_USER }));

    expect('assignedSiteIds' in capturedPayload()).toBe(false);
  });

  it('omits assignedSiteIds for TENANT_ADMIN (they bypass via the role hierarchy)', async () => {
    service = await buildService();
    await mint(service, buildUser({ role: Role.TENANT_ADMIN }));

    // TENANT_ADMIN never queries the site assignment repo.
    expect(siteFind).not.toHaveBeenCalled();
    expect('assignedSiteIds' in capturedPayload()).toBe(false);
  });

  it('omits legacy assignedSiteIds for MODULE_MANAGER (tenant-wide bypass)', async () => {
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_MANAGER }));

    expect(siteFind).not.toHaveBeenCalled();
    expect('assignedSiteIds' in capturedPayload()).toBe(false);
  });

  it('signs with the keyid header SSoT untouched (no RS256/JWKS change)', async () => {
    service = await buildService();
    await mint(service, buildUser({ role: Role.MODULE_USER }));

    // The signing call must still pass keyid + audience — adding claims to the
    // payload must not have altered the signing options path.
    expect(signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access' }),
      expect.objectContaining({ keyid: expect.anything() }),
    );
  });
});
