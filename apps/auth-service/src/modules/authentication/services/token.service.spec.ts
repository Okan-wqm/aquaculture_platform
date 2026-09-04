import { getActiveSigningKid } from '@aquaculture/backend-common/auth';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  ISessionManager,
  IUserTokenRevocation,
  SESSION_MANAGER,
  USER_TOKEN_REVOCATION,
} from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcryptjs';
import { DataSource, Repository } from 'typeorm';

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

function makeTransactionalDataSource(query: jest.Mock): {
  dataSource: object;
  userRepository: { findOne: jest.Mock };
  lockedUserFindOne: jest.Mock;
  transaction: jest.Mock;
} {
  const lockedUserFindOne = jest.fn().mockResolvedValue({ id: 'locked-user' });
  const userRepository = { findOne: lockedUserFindOne };
  const manager = {
    // TypeORM's transaction-scoped repository preserves the repository API;
    // passing the supplied double through lets the same manager scope both
    // assignment reads and the RefreshToken INSERT.
    withRepository: jest.fn((repository: object) => repository),
  };
  const transaction = jest.fn((work: (transactionManager: typeof manager) => Promise<unknown>) =>
    work(manager),
  );
  return {
    dataSource: { query, transaction },
    userRepository,
    lockedUserFindOne,
    transaction,
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
    await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }));

    expect(capturedPayload().planLevel).toBe(2); // professional → PLAN_LEVEL 2
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM auth.tenants'), [
      '22222222-2222-2222-2222-222222222222',
    ]);
  });

  it('omits planLevel for a platform account with no tenant', async () => {
    await service.generateTokens(buildUser({ role: Role.SUPER_ADMIN, tenantId: null }));

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

  // C1 (tenant-isolation invariant): SUPER_ADMIN is the only tenantless role.
  it('rejects issuing a token to a non-SUPER_ADMIN principal with no tenant', async () => {
    await expect(
      service.generateTokens(buildUser({ role: Role.MODULE_USER, tenantId: null })),
    ).rejects.toThrow(/without a tenant/i);
  });

  it('rejects a tenant-scoped TENANT_ADMIN whose tenant resolves to null', async () => {
    await expect(
      service.generateTokens(buildUser({ role: Role.TENANT_ADMIN, tenantId: null })),
    ).rejects.toThrow(/without a tenant/i);
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
      expect(getActiveSigningKid(buildKidConfigService('key-rotated-2'))).toBe(signOptions.keyid);
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
      // Post admin-api `1800500000000-TenantProvisioningTopology` the role
      // tables live in `auth`; tenantId is a bound parameter ($2), so even a
      // malformed value can never reach a schema name or the SQL text.
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

      await service.generateTokens(user);
      expect(capturedPayload().modules).toEqual(['farm']);

      await service.generateTokens(user);
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

      await service.generateTokens(user);
      expect(capturedPayload().resourcePermissions).toEqual(['sites:view']);

      await service.generateTokens(user);
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

      await service.generateTokens(buildUser({}));

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

      await service.generateTokens(buildUser({}));

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

      await service.generateTokens(buildUser({}));

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

      const mint = service.generateTokens(authenticatedSnapshot);
      await Promise.resolve();
      await Promise.resolve();

      expect(refreshSave).not.toHaveBeenCalled();
      expect(signAsync).not.toHaveBeenCalled();
      if (!finishCredentialFence) {
        throw new Error('Credential-fence test gate was not initialized');
      }

      // A concurrent administrator committed deactivation/password mutation
      // while this login waited. The authoritative snapshot predicate no
      // longer resolves, so stale authentication cannot mint a replacement.
      finishCredentialFence(null);
      await expect(mint).rejects.toThrow('User credentials changed during token issuance');

      expect(credentialUserLockFindOne).toHaveBeenCalledWith({
        select: { id: true },
        where: {
          id: authenticatedSnapshot.id,
          role: authenticatedSnapshot.role,
          tenantId: authenticatedSnapshot.tenantId,
          isActive: true,
          updatedAt: authenticatedAt,
        },
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

      const mintPromise = service.generateTokens(buildUser({}));
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

    it('does not enforce or establish a session during refresh-token rotation', async () => {
      service = await createService({ config: { MAX_SESSIONS_PER_USER: 3 } });

      await service.generateTokens(buildUser({}), undefined, undefined, {
        establishSession: false,
      });

      expect(enforceSessionLimit).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(refreshSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction-scoped refresh-token persistence', () => {
    it('persists the replacement row through the active EntityManager repository', async () => {
      service = await createService();
      const transactionDataSource = new DataSource({ type: 'postgres' });
      const transactionManager = transactionDataSource.manager;
      const scopedCreate = jest.fn((value: Partial<RefreshToken>) =>
        Object.assign(new RefreshToken(), value),
      );
      const scopedSave = jest.fn().mockResolvedValue(new RefreshToken());
      const scopedRepository = Object.assign(
        new Repository<RefreshToken>(RefreshToken, transactionManager),
        { create: scopedCreate, save: scopedSave },
      );
      const lockedUserFindOne = jest.fn().mockResolvedValue({ id: 'locked-user' });
      const scopedUserRepository = Object.assign(new Repository<User>(User, transactionManager), {
        findOne: lockedUserFindOne,
      });
      const withRepository = jest
        .spyOn(transactionManager, 'withRepository')
        .mockReturnValueOnce(scopedUserRepository)
        .mockReturnValueOnce(scopedRepository);

      await service.generateTokens(buildUser({ role: Role.TENANT_ADMIN }), undefined, undefined, {
        manager: transactionManager,
        establishSession: false,
      });

      expect(lockedUserFindOne).toHaveBeenCalledWith({
        select: { id: true },
        where: {
          id: '11111111-1111-1111-1111-111111111111',
          role: Role.TENANT_ADMIN,
          tenantId: VALID_TENANT_ID,
          isActive: true,
        },
        lock: { mode: 'pessimistic_write' },
      });
      expect(withRepository).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ findOne: expect.any(Function) }),
      );
      expect(withRepository).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ save: refreshSave }),
      );
      expect(scopedCreate).toHaveBeenCalledTimes(1);
      expect(scopedSave).toHaveBeenCalledTimes(1);
      expect(refreshSave).not.toHaveBeenCalled();
      expect(enforceSessionLimit).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    });

    it('reuses the active EntityManager for the site-authorization snapshot', async () => {
      service = await createService();
      const transactionDataSource = new DataSource({ type: 'postgres' });
      const transactionManager = transactionDataSource.manager;
      const lockedUserFindOne = jest.fn().mockResolvedValue({ id: 'locked-user' });
      const scopedUserRepository = Object.assign(new Repository<User>(User, transactionManager), {
        findOne: lockedUserFindOne,
      });
      const siteAssignments = makeSiteAssignmentRepository(jest.fn().mockResolvedValue([]));
      const scopedSiteRepository = Object.assign(
        new Repository<UserSiteAssignment>(UserSiteAssignment, transactionManager),
        { createQueryBuilder: siteAssignments.repository.createQueryBuilder },
      );
      const scopedRefreshRepository = Object.assign(
        new Repository<RefreshToken>(RefreshToken, transactionManager),
        {
          create: jest.fn((value: Partial<RefreshToken>) =>
            Object.assign(new RefreshToken(), value),
          ),
          save: jest.fn().mockResolvedValue(new RefreshToken()),
        },
      );
      const withRepository = jest
        .spyOn(transactionManager, 'withRepository')
        .mockReturnValueOnce(scopedUserRepository)
        .mockReturnValueOnce(scopedSiteRepository)
        .mockReturnValueOnce(scopedRefreshRepository);

      await service.generateTokens(buildUser({ role: Role.MODULE_USER }), undefined, undefined, {
        manager: transactionManager,
        establishSession: false,
      });

      expect(siteSnapshotTransaction).not.toHaveBeenCalled();
      expect(lockedUserFindOne).toHaveBeenCalledWith({
        select: { id: true },
        where: {
          id: '11111111-1111-1111-1111-111111111111',
          role: Role.MODULE_USER,
          tenantId: VALID_TENANT_ID,
          isActive: true,
        },
        lock: { mode: 'pessimistic_write' },
      });
      expect(withRepository).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ findOne: expect.any(Function) }),
      );
      expect(withRepository).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ createQueryBuilder: expect.any(Function) }),
      );
      expect(withRepository).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ save: refreshSave }),
      );
      expect(scopedRefreshRepository.save).toHaveBeenCalledTimes(1);
    });
  });

  // HASH_REFRESH_TOKENS=true exercises the bcrypt + rolling-compatible V2
  // two-segment transport. The opaque secret embeds the indexed tokenId while
  // retaining the legacy `userId:secret` split consumed during rollout.
  describe('refresh-token hashing (HASH_REFRESH_TOKENS=true)', () => {
    it('stores tokenId + hash and returns exactly userId:secret with tokenId embedded', async () => {
      mockBcryptHash.mockResolvedValue('bcrypt-hash');
      service = await createService({ config: { HASH_REFRESH_TOKENS: true } });

      const user = buildUser({});
      const result = await service.generateTokens(user);

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

      await service.generateTokens(buildUser({}));

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

      await service.generateTokens(buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      expect(minutesFromNow(savedRow.expiresAt)).toBeGreaterThan(29);
      expect(minutesFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(30);
    });

    it('lets the tenant policy win over a rememberMe extension', async () => {
      service = await createService({
        query: routerWithPolicy(45),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 7, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      const result = await service.generateTokens(buildUser({}), undefined, undefined, {
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

      await service.generateTokens(buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      expect(minutesFromNow(savedRow.expiresAt)).toBeGreaterThan(7 * 24 * 60 - 1);
    });

    it('never lets a longer tenant policy EXTEND the configured TTL', async () => {
      service = await createService({
        query: routerWithPolicy(1440),
        config: { REFRESH_TOKEN_EXPIRY_DAYS: 0.5, REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30 },
      });

      await service.generateTokens(buildUser({}));

      const savedRow = refreshSave.mock.calls[0]?.[0] as { expiresAt: Date };
      // MIN wins: 0.5 day (720 min) is shorter than the 1440-minute policy.
      expect(minutesFromNow(savedRow.expiresAt)).toBeLessThanOrEqual(720);
    });

    it('exposes NO caller-supplied session-timeout parameter (the clamp cannot be forgotten)', () => {
      // ADMIN-HIGH-015 root cause: the clamp used to be an optional argument
      // five of seven mint paths omitted. Pin that generateTokens takes exactly
      // (user, ipAddress, userAgent, options) and that the options bag carries
      // no timeout knob — a caller has nothing to pass and nothing to forget.
      expect(TokenService.prototype.generateTokens).toHaveLength(4);
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
    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect(capturedPayload().assignedSiteIds).toEqual(['site-a', 'site-b']);
    expect(lockedUserFindOne).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        id: USER,
        role: Role.MODULE_USER,
        tenantId: TENANT,
        isActive: true,
      },
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

    const result = await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect(capturedPayload().assignedSiteIds).toEqual(['site-long', 'site-short']);
    expect(signAsync).toHaveBeenCalledWith(
      expect.objectContaining({ iat: now / 1000 }),
      expect.objectContaining({ expiresIn: 120 }),
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

    await service.generateTokens(buildUser({ role: Role.MODULE_USER }));

    expect('assignedSiteIds' in capturedPayload()).toBe(false);
    dateNow.mockRestore();
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

  it('omits legacy assignedSiteIds for MODULE_MANAGER (tenant-wide bypass)', async () => {
    service = await buildService();
    await service.generateTokens(buildUser({ role: Role.MODULE_MANAGER }));

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
