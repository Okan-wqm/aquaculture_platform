import { Role } from '@aquaculture/backend-common/decorators';
import { USER_TOKEN_REVOCATION } from '@aquaculture/backend-common/security';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { MODULE_ACCESS_METRICS_REGISTRY } from '../../../metrics/module-access.metrics';
import { MobileSettingsService } from '../../tenant/services/mobile-settings.service';
import { RefreshToken } from '../entities/refresh-token.entity';
import { UserSiteAssignment } from '../entities/user-site-assignment.entity';
import { User } from '../entities/user.entity';

import { JwtPayload, TokenService } from './token.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

interface ModuleRow {
  code: string;
  name: string;
  defaultRoute: string;
  role?: string | null;
}

function moduleRow(code: string, role?: string | null): ModuleRow {
  return { code, name: code, defaultRoute: `/${code}`, role };
}

interface Harness {
  service: TokenService;
  payload: () => JwtPayload;
  query: jest.Mock;
  userFindOne: jest.Mock;
  siteFind: jest.Mock;
}

/**
 * TokenService over a query router: member assignments, the tenant's enabled modules and the
 * plan row are answered by the table each SQL names; every other read is empty.
 */
async function buildHarness(rows: {
  member?: ModuleRow[];
  tenant?: ModuleRow[];
  sites?: Array<{ siteId: string; isActive: boolean; expiresAt: Date | null }>;
}): Promise<Harness> {
  let lastPayload: JwtPayload | undefined;
  const signAsync = jest.fn((payload: JwtPayload) => {
    lastPayload = payload;
    return Promise.resolve('signed.access.token');
  });
  const query = jest.fn((sql: string) => {
    if (sql.includes('user_module_assignments')) return Promise.resolve(rows.member ?? []);
    if (sql.includes('FROM auth.tenant_modules')) return Promise.resolve(rows.tenant ?? []);
    if (sql.includes('FROM auth.tenants')) return Promise.resolve([{ plan: 'professional' }]);
    return Promise.resolve([]);
  });
  const userFindOne = jest.fn().mockResolvedValue({ id: 'locked-user' });
  const siteFind = jest.fn().mockResolvedValue(rows.sites ?? []);
  const siteQueryBuilder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    setLock: jest.fn(),
    getMany: siteFind,
  };
  siteQueryBuilder.where.mockReturnValue(siteQueryBuilder);
  siteQueryBuilder.andWhere.mockReturnValue(siteQueryBuilder);
  siteQueryBuilder.orderBy.mockReturnValue(siteQueryBuilder);
  siteQueryBuilder.setLock.mockReturnValue(siteQueryBuilder);
  const manager = { withRepository: jest.fn((repository: object) => repository) };
  const dataSource = {
    query,
    transaction: jest.fn((work: (transactionManager: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      TokenService,
      { provide: getRepositoryToken(User), useValue: { findOne: userFindOne } },
      {
        provide: getRepositoryToken(RefreshToken),
        useValue: { create: jest.fn((x: unknown) => x), save: jest.fn() },
      },
      {
        provide: getRepositoryToken(UserSiteAssignment),
        useValue: {
          find: siteFind,
          createQueryBuilder: jest.fn().mockReturnValue(siteQueryBuilder),
        },
      },
      {
        provide: MobileSettingsService,
        useValue: {
          getByUserId: jest.fn().mockResolvedValue({ isMobileEnabled: false, allowedFeatures: {} }),
        },
      },
      { provide: DataSource, useValue: dataSource },
      { provide: JwtService, useValue: { signAsync } },
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, def?: unknown) =>
            key === 'HASH_REFRESH_TOKENS' ? false : def,
          ),
        },
      },
      {
        provide: USER_TOKEN_REVOCATION,
        useValue: {
          revokeUserTokens: jest.fn().mockResolvedValue(undefined),
          isTokenValid: jest.fn().mockResolvedValue(true),
        },
      },
    ],
  }).compile();

  return {
    service: moduleRef.get(TokenService),
    payload: (): JwtPayload => {
      if (!lastPayload) throw new Error('no token was signed');
      return lastPayload;
    },
    query,
    userFindOne,
    siteFind,
  };
}

function buildUser(role: Role): User {
  return Object.assign(new User(), {
    id: USER_ID,
    role,
    tenantId: TENANT_ID,
    credentialVersion: 1,
    isActive: true,
  });
}

async function droppedCount(reason: string): Promise<number> {
  const metric = MODULE_ACCESS_METRICS_REGISTRY.getSingleMetric('auth_module_access_dropped_total');
  if (!metric) throw new Error('auth_module_access_dropped_total is not registered');
  const { values } = await metric.get();
  return values.find((value) => value.labels['reason'] === reason)?.value ?? 0;
}

/**
 * The moduleAccess claim, minted (ADR-051 §2; RBAC-HIGH-027, RBAC-MEDIUM-029): every access
 * token carries it, built by the one module-access reader, beside the legacy `modules` claim the
 * R1 web still reads (C1).
 */
describe('TokenService — the moduleAccess claim (RBAC-HIGH-027, RBAC-MEDIUM-029)', () => {
  it("mints {farm: MODULE_MANAGER} into a farm manager's token (PKG-04 accept)", async () => {
    const harness = await buildHarness({ member: [moduleRow('farm', 'MODULE_MANAGER')] });

    await harness.service.generateTokens(buildUser(Role.MODULE_MANAGER));

    expect(harness.payload().moduleAccess).toEqual({ farm: 'MODULE_MANAGER' });
    expect(harness.payload().modules).toEqual(['farm']);
  });

  it('mints the claim even when it holds no grant, so a token minted before R1 stays distinguishable', async () => {
    const harness = await buildHarness({ member: [] });

    await harness.service.generateTokens(buildUser(Role.MODULE_USER));

    expect(harness.payload().moduleAccess).toEqual({});
    expect('modules' in harness.payload()).toBe(false);
  });

  it('mints every enabled owner module as MODULE_MANAGER for TENANT_ADMIN', async () => {
    const harness = await buildHarness({
      tenant: [moduleRow('farm'), moduleRow('sensor'), moduleRow('ai')],
    });

    await harness.service.generateTokens(buildUser(Role.TENANT_ADMIN));

    expect(harness.payload().moduleAccess).toEqual({
      farm: 'MODULE_MANAGER',
      sensor: 'MODULE_MANAGER',
    });
    expect(harness.payload().modules).toEqual(['farm', 'sensor', 'ai']);
  });

  it("builds the member's legacy modules claim from the same read, joined to the tenant's enabled modules", async () => {
    const harness = await buildHarness({ member: [moduleRow('sensor', 'MODULE_USER')] });

    await harness.service.generateTokens(buildUser(Role.MODULE_USER));

    const memberRead = harness.query.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('user_module_assignments'),
    );
    expect(memberRead?.[0]).toContain('tm."isEnabled" = true');
    expect(harness.payload().modules).toEqual(['sensor']);
  });

  it('counts each code it leaves out of the claim', async () => {
    const before = {
      notOwner: await droppedCount('not_owner_module'),
      roleMissing: await droppedCount('role_missing'),
    };
    const harness = await buildHarness({
      member: [moduleRow('alert', 'MODULE_USER'), moduleRow('farm', null)],
    });

    await harness.service.generateTokens(buildUser(Role.MODULE_USER));

    expect(harness.payload().moduleAccess).toEqual({});
    expect(await droppedCount('not_owner_module')).toBe(before.notOwner + 1);
    expect(await droppedCount('role_missing')).toBe(before.roleMissing + 1);
  });

  it('readModuleAccess answers what a fresh token would carry (the me query reads it)', async () => {
    const harness = await buildHarness({ member: [moduleRow('hr', 'MODULE_USER')] });

    const read = await harness.service.readModuleAccess(buildUser(Role.MODULE_MANAGER));

    expect(read.moduleAccess).toEqual({ hr: 'MODULE_USER' });
    expect(read.modules).toEqual([{ code: 'hr', name: 'hr', defaultRoute: '/hr' }]);
  });

  describe('resolveCallerCapabilities (RBAC-HIGH-028: the messaging bridge path)', () => {
    it('answers the moduleAccess and assignedSiteIds a fresh token would carry', async () => {
      const harness = await buildHarness({
        member: [moduleRow('farm', 'MODULE_USER')],
        sites: [
          { siteId: 'site-a', isActive: true, expiresAt: null },
          { siteId: 'site-b', isActive: true, expiresAt: null },
        ],
      });
      harness.userFindOne.mockResolvedValue(buildUser(Role.MODULE_USER));

      const resolved = await harness.service.resolveCallerCapabilities(TENANT_ID, USER_ID);

      expect(resolved).toEqual({
        found: true,
        active: true,
        roles: ['MODULE_USER'],
        resourcePermissions: [],
        moduleAccess: { farm: 'MODULE_USER' },
        assignedSiteIds: ['site-a', 'site-b'],
      });
      expect(harness.siteFind).toHaveBeenCalledWith({
        where: { userId: USER_ID, tenantId: TENANT_ID, isActive: true },
        order: { siteId: 'ASC' },
      });
    });

    it('answers no grants and no sites for a user outside the tenant', async () => {
      const harness = await buildHarness({ member: [moduleRow('farm', 'MODULE_USER')] });
      harness.userFindOne.mockResolvedValue(null);

      const resolved = await harness.service.resolveCallerCapabilities(TENANT_ID, USER_ID);

      expect(resolved).toEqual({
        found: false,
        active: false,
        roles: [],
        resourcePermissions: [],
        moduleAccess: {},
        assignedSiteIds: [],
      });
      expect(harness.query).not.toHaveBeenCalled();
    });
  });
});
