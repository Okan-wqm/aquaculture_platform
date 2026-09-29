import { Role } from '@aquaculture/backend-common/decorators';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ALERT_RECIPIENT_RESULT_MAX_USER_IDS } from '@platform/event-contracts';
import { In } from 'typeorm';

import { UserSiteAssignment } from '../../entities/user-site-assignment.entity';
import { User } from '../../entities/user.entity';
import { AlertRecipientDirectoryService } from '../alert-recipient-directory.service';

/**
 * ALERT-CRITICAL-004 — who an escalated alarm pages. The directory's owner
 * resolves roles to ACTIVE tenant users at delivery time; every lookup is
 * tenant-scoped and the answer is ids only.
 */
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER_AT_SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_ELSEWHERE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MANAGER_EXPIRED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-09-29T08:00:00.000Z');

function assignment(
  userId: string,
  overrides: Partial<UserSiteAssignment> = {},
): UserSiteAssignment {
  return Object.assign(new UserSiteAssignment(), {
    userId,
    siteId: SITE_ID,
    tenantId: TENANT_ID,
    isActive: true,
    expiresAt: null,
    ...overrides,
  });
}

async function build(): Promise<{
  service: AlertRecipientDirectoryService;
  users: { find: jest.Mock };
  assignments: { find: jest.Mock };
}> {
  const users = {
    find: jest.fn(async (options: { where: { role?: unknown; id?: unknown } }) => {
      const where = options.where;
      if (where.id !== undefined) return [{ id: ADMIN }];
      // Holders of every role the query names (one query may name several).
      const roles = JSON.stringify(where.role);
      const holders: Array<{ id: string }> = [];
      if (roles.includes(Role.TENANT_ADMIN)) holders.push({ id: ADMIN });
      if (roles.includes(Role.MODULE_MANAGER)) {
        holders.push({ id: MANAGER_AT_SITE }, { id: MANAGER_ELSEWHERE }, { id: MANAGER_EXPIRED });
      }
      return holders;
    }),
  };
  const assignments = {
    find: jest.fn(async () => [
      assignment(MANAGER_AT_SITE),
      assignment(MANAGER_EXPIRED, { expiresAt: new Date('2026-09-01T00:00:00.000Z') }),
    ]),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AlertRecipientDirectoryService,
      { provide: getRepositoryToken(User), useValue: users },
      { provide: getRepositoryToken(UserSiteAssignment), useValue: assignments },
    ],
  }).compile();
  return { service: moduleRef.get(AlertRecipientDirectoryService), users, assignments };
}

describe('AlertRecipientDirectoryService', () => {
  it('pages tenant admins and only the managers effectively assigned to the site', async () => {
    // SCENARIO: the default policy for an incident at SITE_ID.
    // EXPECTS: the admin + the manager assigned to the site; a manager of another
    //          site and one whose assignment expired are NOT paged.
    const { service, users, assignments } = await build();

    const result = await service.resolve(
      TENANT_ID,
      {
        tenantWideRoles: ['TENANT_ADMIN'],
        siteRoles: ['MODULE_MANAGER'],
        siteId: SITE_ID,
        userIds: [],
      },
      NOW,
    );

    // V-S1b-7: ranked — the site's own manager first, tenant-wide holders after.
    expect(result).toEqual({ userIds: [MANAGER_AT_SITE, ADMIN], truncated: false });
    // Every lookup is tenant-scoped and ACTIVE-only.
    for (const call of users.find.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: TENANT_ID, isActive: true });
    }
    expect(assignments.find).toHaveBeenCalledWith({
      where: {
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        isActive: true,
        userId: In([MANAGER_AT_SITE, MANAGER_ELSEWHERE, MANAGER_EXPIRED]),
      },
    });
  });

  it('widens site roles to the tenant when the incident has no site', async () => {
    // SCENARIO: a pool-level stock incident (no site).
    // EXPECTS: every active manager is paged — a missing site never silences an alarm.
    const { service, assignments } = await build();

    const result = await service.resolve(
      TENANT_ID,
      {
        tenantWideRoles: ['TENANT_ADMIN'],
        siteRoles: ['MODULE_MANAGER'],
        siteId: null,
        userIds: [],
      },
      NOW,
    );

    expect(result.userIds).toEqual(
      [ADMIN, MANAGER_AT_SITE, MANAGER_ELSEWHERE, MANAGER_EXPIRED].sort(),
    );
    expect(assignments.find).not.toHaveBeenCalled();
  });

  it('keeps only explicit ids that are active members of the tenant', async () => {
    // SCENARIO: a policy lists a user of this tenant and a foreign id.
    // EXPECTS: the lookup is tenant-bound; the foreign id simply does not come back.
    const { service, users } = await build();
    const foreign = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    const result = await service.resolve(
      TENANT_ID,
      { tenantWideRoles: [], siteRoles: [], siteId: null, userIds: [ADMIN, foreign] },
      NOW,
    );

    expect(result.userIds).toEqual([ADMIN]);
    expect(users.find).toHaveBeenCalledWith({
      select: ['id'],
      where: { tenantId: TENANT_ID, isActive: true, id: In([ADMIN, foreign]) },
    });
  });

  it('widens a site role nobody at the site holds to the tenant (V-S1a-5)', async () => {
    // SCENARIO: no manager is assigned to the incident's site.
    // EXPECTS: every active manager of the tenant is paged instead of none.
    const { service, assignments } = await build();
    assignments.find.mockResolvedValue([]);

    const result = await service.resolve(
      TENANT_ID,
      { tenantWideRoles: [], siteRoles: ['MODULE_MANAGER'], siteId: SITE_ID, userIds: [] },
      NOW,
    );

    expect(result.userIds).toEqual([MANAGER_AT_SITE, MANAGER_ELSEWHERE, MANAGER_EXPIRED].sort());
  });

  it("cuts tenant-wide holders before the site's own managers at the cap (V-S1b-7)", async () => {
    // SCENARIO: more tenant admins than the cap, plus one site manager whose id
    //           sorts last.
    // EXPECTS: the site manager is kept; the truncation eats tenant-wide admins.
    const lastSorting = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const admins = Array.from(
      { length: ALERT_RECIPIENT_RESULT_MAX_USER_IDS + 5 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const { service, users, assignments } = await build();
    users.find.mockImplementation(async (options: { where: { role?: unknown } }) => {
      const roles = JSON.stringify(options.where.role);
      if (roles.includes(Role.MODULE_MANAGER)) return [{ id: lastSorting }];
      return admins.map((id) => ({ id }));
    });
    assignments.find.mockResolvedValue([assignment(lastSorting)]);

    const result = await service.resolve(
      TENANT_ID,
      {
        tenantWideRoles: ['TENANT_ADMIN'],
        siteRoles: ['MODULE_MANAGER'],
        siteId: SITE_ID,
        userIds: [],
      },
      NOW,
    );

    expect(result.truncated).toBe(true);
    expect(result.userIds).toHaveLength(ALERT_RECIPIENT_RESULT_MAX_USER_IDS);
    expect(result.userIds[0]).toBe(lastSorting);
  });
});
