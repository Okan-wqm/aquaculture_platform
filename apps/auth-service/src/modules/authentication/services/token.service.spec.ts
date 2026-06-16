import { Role } from '@aquaculture/backend-common/decorators';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserModuleAssignment } from '../entities/user-module-assignment.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

import { JwtPayload, TokenService } from './token.service';

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
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        {
          // Mobile disabled by default → no mobileFeatures claim in these
          // planLevel-focused tests (the dedicated suite below covers it).
          provide: MobileSettingsService,
          useValue: {
            getByUserId: jest
              .fn()
              .mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }),
          },
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
 * SEC-HIGH-051 / SEC-HIGH-052 — the assignedSiteIds + mobileFeatures JWT claims.
 *
 * generateTokens must stamp a MODULE_USER's active site assignments and enabled
 * mobile features onto the access token, omit them when empty, and never touch
 * the RS256/keyid signing path.
 */
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
