/**
 * GetSiteDeletePreviewHandler — Unit Tests
 *
 * Reads now flow through the fail-closed tenant boundary
 * (`runInTenantRead`): every domain query runs inside an explicit
 * read-only transaction whose `current_schema()` + RLS GUC are asserted
 * before the first row is read, so a lost tenant context throws a typed
 * error instead of silently resolving against the source `farm` schema.
 *
 * These tests pin the same behaviour the repository-based handler used
 * to guarantee:
 *
 *   1. Systems with equipment get the correct count (per junction).
 *   2. Systems without equipment get 0 — no ghost count.
 *   3. A single equipment item linked to TWO systems counts for
 *      BOTH — reflects the real many-to-many relationship.
 *   4. Only the target tenant's junction rows are considered.
 *   5. NotFoundException is still thrown for a missing site (existing
 *      contract preserved, raised INSIDE the boundary).
 *   6. Biomass blocker still triggers `canDelete = false`.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityTarget, ObjectLiteral } from 'typeorm';

import { Role } from '@aquaculture/backend-common/decorators';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { createMockDataSource } from '@aquaculture/testing';

import { GetSiteDeletePreviewHandler } from '../handlers/get-site-delete-preview.handler';
import { GetSiteDeletePreviewQuery } from '../queries/get-site-delete-preview.query';
import { Site } from '../entities/site.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { Tank } from '../../tank/entities/tank.entity';

const SITE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MANAGER = {
  sub: 'manager-1',
  roles: [Role.MODULE_MANAGER],
};

interface Qb {
  where: jest.Mock;
  andWhere: jest.Mock;
  getMany: jest.Mock;
}

function makeQb(rows: unknown[]): Qb {
  const qb: Qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

function makeHandler(opts: {
  site: Partial<Site> | null;
  departments: Partial<Department>[];
  systems: Partial<System>[];
  tanks: Partial<Tank>[];
  equipment: Partial<Equipment>[];
  equipmentSystemLinks: Partial<EquipmentSystem>[];
}): {
  handler: GetSiteDeletePreviewHandler;
  equipmentSystemFind: jest.Mock;
} {
  const { mockDataSource, mockManager } = createMockDataSource();

  // findOne(Site) → site; find(Department/System/EquipmentSystem) keyed
  // by entity so call-order independence holds.
  (mockManager.findOne as jest.Mock).mockResolvedValue(opts.site);

  const equipmentSystemFind = jest.fn().mockResolvedValue(opts.equipmentSystemLinks);

  (mockManager.find as jest.Mock).mockImplementation(
    (entity: EntityTarget<ObjectLiteral>, options?: unknown) => {
      if (entity === Department) {
        return Promise.resolve(opts.departments);
      }
      if (entity === System) {
        return Promise.resolve(opts.systems);
      }
      if (entity === EquipmentSystem) {
        return equipmentSystemFind(options);
      }
      return Promise.resolve([]);
    },
  );

  mockManager.createQueryBuilder = jest
    .fn()
    .mockImplementation((entity: EntityTarget<ObjectLiteral>) => {
      if (entity === Tank) {
        return makeQb(opts.tanks);
      }
      if (entity === Equipment) {
        return makeQb(opts.equipment);
      }
      return makeQb([]);
    }) as typeof mockManager.createQueryBuilder;

  const handler = new GetSiteDeletePreviewHandler(mockDataSource, new SiteAuthorizationService());
  return { handler, equipmentSystemFind };
}

describe('GetSiteDeletePreviewHandler', () => {
  it('throws NotFoundException when the site does not exist', async () => {
    const { handler } = makeHandler({
      site: null,
      departments: [],
      systems: [],
      tanks: [],
      equipment: [],
      equipmentSystemLinks: [],
    });

    await expect(
      handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER)),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects an unassigned MODULE_USER before reading the site or its children', async () => {
    const { mockDataSource } = createMockDataSource();
    const handler = new GetSiteDeletePreviewHandler(mockDataSource, new SiteAuthorizationService());

    await expect(
      handler.execute(
        new GetSiteDeletePreviewQuery(SITE_ID, TENANT, {
          sub: 'user-1',
          roles: [Role.MODULE_USER],
          assignedSiteIds: ['another-site'],
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
  });

  it('reports per-system equipment counts via the equipment_systems junction', async () => {
    const { handler, equipmentSystemFind } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [{ id: 'dept-1', tenantId: TENANT, name: 'D1', code: 'D1' }],
      systems: [
        { id: 'sys-a', tenantId: TENANT, name: 'RAS A', code: 'SA' },
        { id: 'sys-b', tenantId: TENANT, name: 'RAS B', code: 'SB' },
        { id: 'sys-c', tenantId: TENANT, name: 'RAS C', code: 'SC' },
      ],
      tanks: [],
      equipment: [],
      equipmentSystemLinks: [
        // sys-a: 2 items
        { systemId: 'sys-a', equipmentId: 'eq-1' },
        { systemId: 'sys-a', equipmentId: 'eq-2' },
        // sys-b: 1 item (shared with sys-a via separate link)
        { systemId: 'sys-b', equipmentId: 'eq-1' },
        // sys-c: none
      ],
    });

    const response = await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER));

    // Query scoped to the target tenant + the systems list — no
    // cross-tenant bleed.
    expect(equipmentSystemFind).toHaveBeenCalledWith({
      where: { tenantId: TENANT, systemId: expect.anything() },
      select: ['systemId'],
    });

    const summaries = response.affectedItems.systems;
    const byCode = Object.fromEntries(summaries.map((s) => [s.code, s.equipmentCount]));
    expect(byCode).toEqual({ SA: 2, SB: 1, SC: 0 });
  });

  it('counts a shared equipment for EACH system it is linked to (many-to-many)', async () => {
    const { handler } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [{ id: 'dept-1', tenantId: TENANT, name: 'D1', code: 'D1' }],
      systems: [
        { id: 'sys-a', tenantId: TENANT, name: 'RAS A', code: 'SA' },
        { id: 'sys-b', tenantId: TENANT, name: 'RAS B', code: 'SB' },
      ],
      tanks: [],
      equipment: [],
      // Same equipment item attached to BOTH systems — the operator
      // needs to see that deleting the site affects both.
      equipmentSystemLinks: [
        { systemId: 'sys-a', equipmentId: 'shared-eq' },
        { systemId: 'sys-b', equipmentId: 'shared-eq' },
      ],
    });

    const response = await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER));
    const byCode = Object.fromEntries(
      response.affectedItems.systems.map((s) => [s.code, s.equipmentCount]),
    );
    expect(byCode).toEqual({ SA: 1, SB: 1 });
  });

  it('returns zero-count systems without skipping them', async () => {
    const { handler, equipmentSystemFind } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [{ id: 'dept-1', tenantId: TENANT, name: 'D1', code: 'D1' }],
      systems: [{ id: 'sys-empty', tenantId: TENANT, name: 'Empty', code: 'E1' }],
      tanks: [],
      equipment: [],
      equipmentSystemLinks: [],
    });

    const response = await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER));
    expect(response.affectedItems.systems).toHaveLength(1);
    expect(response.affectedItems.systems[0]!.equipmentCount).toBe(0);
    expect(equipmentSystemFind).toHaveBeenCalledTimes(1);
  });

  it('skips the junction query when no systems exist on the site', async () => {
    const { handler, equipmentSystemFind } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [],
      systems: [],
      tanks: [],
      equipment: [],
      equipmentSystemLinks: [],
    });

    await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER));
    // Avoids an empty-IN query — match the handler's guard.
    expect(equipmentSystemFind).not.toHaveBeenCalled();
  });

  it('reports a blocker when tanks contain active biomass', async () => {
    const tank: Partial<Tank> = {
      id: 't1',
      tenantId: TENANT,
      departmentId: 'dept-1',
      name: 'T1',
      code: 'T1',
      currentBiomass: 450,
    };
    const { handler } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [{ id: 'dept-1', tenantId: TENANT, name: 'D1', code: 'D1' }],
      systems: [],
      tanks: [tank],
      equipment: [],
      equipmentSystemLinks: [],
    });

    const response = await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT, MANAGER));
    expect(response.canDelete).toBe(false);
    expect(response.blockers[0]).toContain('450.00 kg');
  });
});
