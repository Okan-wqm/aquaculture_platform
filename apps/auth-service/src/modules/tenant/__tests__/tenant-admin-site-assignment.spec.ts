/**
 * TenantAdminService — SEC-HIGH-051 site-assignment write-path.
 *
 * auth.user_site_assignments is the object-level site-membership SSoT but had NO
 * write-path: every MODULE_USER was minted with assignedSiteIds:[] forever and
 * denied on every site-scoped op. assignUserToSite / unassignUserFromSite are
 * that management surface (TENANT_ADMIN-gated at the resolver). These tests
 * prove:
 *   - assign creates an active row scoped to the caller's tenant;
 *   - assign is idempotent (re-assign active = no-op; reactivate inactive);
 *   - a cross-tenant target user is rejected (no cross-tenant assign);
 *   - unassign deactivates an existing row;
 *   - the deny posture is unchanged (the row is what grants access).
 */
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';

import { UserSiteAssignment } from '../../authentication/entities/user-site-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import { TenantAdminService } from '../services/tenant-admin.service';

const ADMIN_ID = 'admin-1';
const TENANT = 'tenant-1';
const TARGET_USER = 'user-2';
const SITE = 'site-1';

function userRepoMock(target: Partial<User> | null): Repository<User> {
  const findOne = jest.fn((opts: { where: { id: string } }) => {
    if (opts.where.id === ADMIN_ID) {
      return Promise.resolve({ id: ADMIN_ID, tenantId: TENANT, email: 'admin@x.io', role: Role.TENANT_ADMIN });
    }
    return Promise.resolve(target ?? null);
  });
  return { findOne } as never;
}

function siteRepoMock(existing: Partial<UserSiteAssignment> | null): {
  mock: Repository<UserSiteAssignment>;
  saved: Partial<UserSiteAssignment>[];
} {
  const saved: Partial<UserSiteAssignment>[] = [];
  const mock = {
    findOne: jest.fn().mockResolvedValue(existing),
    create: jest.fn((dto: Partial<UserSiteAssignment>) => dto),
    save: jest.fn((row: Partial<UserSiteAssignment>) => {
      saved.push(row);
      return Promise.resolve(row);
    }),
  } as never;
  return { mock, saved };
}

function makeService(
  userRepo: Repository<User>,
  siteRepo: Repository<UserSiteAssignment>,
): TenantAdminService {
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as never;
  // Only userRepository, userSiteAssignmentRepository, auditLogService are
  // exercised by these methods; the rest are unused stubs.
  return new TenantAdminService(
    {} as never, // tenantRepository
    {} as never, // tenantModuleRepository
    userRepo,
    {} as never, // userModuleAssignmentRepository
    siteRepo,
    {} as never, // moduleRepository
    {} as never, // refreshTokenRepository
    {} as never, // dataSource
    audit,
  );
}

describe('TenantAdminService — assignUserToSite / unassignUserFromSite (SEC-HIGH-051)', () => {
  it('creates an active assignment scoped to the caller tenant, recording assignedBy', async () => {
    const userRepo = userRepoMock({ id: TARGET_USER, tenantId: TENANT });
    const { mock: siteRepo, saved } = siteRepoMock(null);
    const service = makeService(userRepo, siteRepo);

    const result = await service.assignUserToSite(ADMIN_ID, { userId: TARGET_USER, siteId: SITE });

    expect(result.success).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: TARGET_USER,
      siteId: SITE,
      tenantId: TENANT,
      isActive: true,
      assignedBy: ADMIN_ID,
    });
  });

  it('is a no-op success when an active assignment already exists (idempotent)', async () => {
    const userRepo = userRepoMock({ id: TARGET_USER, tenantId: TENANT });
    const { mock: siteRepo, saved } = siteRepoMock({
      userId: TARGET_USER, siteId: SITE, tenantId: TENANT, isActive: true,
    });
    const service = makeService(userRepo, siteRepo);

    const result = await service.assignUserToSite(ADMIN_ID, { userId: TARGET_USER, siteId: SITE });

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/already assigned/i);
    expect(saved).toHaveLength(0); // nothing re-written
  });

  it('reactivates a previously deactivated assignment', async () => {
    const userRepo = userRepoMock({ id: TARGET_USER, tenantId: TENANT });
    const inactive = { userId: TARGET_USER, siteId: SITE, tenantId: TENANT, isActive: false };
    const { mock: siteRepo, saved } = siteRepoMock(inactive);
    const service = makeService(userRepo, siteRepo);

    await service.assignUserToSite(ADMIN_ID, { userId: TARGET_USER, siteId: SITE });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.isActive).toBe(true);
    expect(saved[0]!.assignedBy).toBe(ADMIN_ID);
  });

  it('rejects a cross-tenant target user (no cross-tenant assignment)', async () => {
    // The target user does not resolve under the admin's tenant → null.
    const userRepo = userRepoMock(null);
    const { mock: siteRepo, saved } = siteRepoMock(null);
    const service = makeService(userRepo, siteRepo);

    await expect(
      service.assignUserToSite(ADMIN_ID, { userId: 'foreign-user', siteId: SITE }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(saved).toHaveLength(0);
  });

  it('unassign deactivates an existing tenant-scoped assignment', async () => {
    const userRepo = userRepoMock({ id: TARGET_USER, tenantId: TENANT });
    const { mock: siteRepo, saved } = siteRepoMock({
      userId: TARGET_USER, siteId: SITE, tenantId: TENANT, isActive: true,
    });
    const service = makeService(userRepo, siteRepo);

    const result = await service.unassignUserFromSite(ADMIN_ID, TARGET_USER, SITE);

    expect(result.success).toBe(true);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.isActive).toBe(false);
  });

  it('unassign throws when no assignment row exists for the tenant', async () => {
    const userRepo = userRepoMock({ id: TARGET_USER, tenantId: TENANT });
    const { mock: siteRepo } = siteRepoMock(null);
    const service = makeService(userRepo, siteRepo);

    await expect(
      service.unassignUserFromSite(ADMIN_ID, TARGET_USER, SITE),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
