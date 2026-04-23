/**
 * GetSiteDeletePreviewHandler — Unit Tests
 *
 * Closes a long-standing preview bug: the per-system `equipmentCount`
 * was hard-coded to 0 with a `// TODO: Query EquipmentSystem junction
 * table` comment, which meant the delete confirmation modal reported
 * every system as empty even when it had active equipment attached
 * through the `equipment_systems` junction. An operator could
 * accept the delete believing nothing would be affected.
 *
 * The handler now joins through `EquipmentSystem` to aggregate per
 * (tenantId, systemId). Tests pin:
 *
 *   1. Systems with equipment get the correct count (per junction).
 *   2. Systems without equipment get 0 — no ghost count.
 *   3. A single equipment item linked to TWO systems counts for
 *      BOTH — reflects the real many-to-many relationship.
 *   4. Only the target tenant's junction rows are considered.
 *   5. NotFoundException is still thrown for a missing site (existing
 *      contract preserved).
 *   6. Biomass blocker still triggers `canDelete = false`.
 */
import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';

import { GetSiteDeletePreviewHandler } from '../handlers/get-site-delete-preview.handler';
import { GetSiteDeletePreviewQuery } from '../queries/get-site-delete-preview.query';
import { Site } from '../entities/site.entity';
import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Equipment } from '../../equipment/entities/equipment.entity';
import { EquipmentSystem } from '../../equipment/entities/equipment-system.entity';
import { Tank } from '../../tank/entities/tank.entity';

interface RepoMock {
  findOne: jest.Mock;
  find: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function makeQb(rows: unknown[]): { getMany: jest.Mock; andWhere: jest.Mock; where: jest.Mock } {
  const qb: any = {
    getMany: jest.fn().mockResolvedValue(rows),
  };
  qb.where = jest.fn().mockReturnValue(qb);
  qb.andWhere = jest.fn().mockReturnValue(qb);
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
  const siteRepo: RepoMock = {
    findOne: jest.fn().mockResolvedValue(opts.site),
    find: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const departmentRepo: RepoMock = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue(opts.departments),
    createQueryBuilder: jest.fn(),
  };
  const systemRepo: RepoMock = {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue(opts.systems),
    createQueryBuilder: jest.fn(),
  };
  const tankRepo: RepoMock = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb(opts.tanks)),
  };
  const equipmentRepo: RepoMock = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(makeQb(opts.equipment)),
  };
  const equipmentSystemFind = jest.fn().mockResolvedValue(opts.equipmentSystemLinks);
  const equipmentSystemRepo: RepoMock = {
    findOne: jest.fn(),
    find: equipmentSystemFind,
    createQueryBuilder: jest.fn(),
  };

  const handler = new GetSiteDeletePreviewHandler(
    siteRepo as unknown as Repository<Site>,
    departmentRepo as unknown as Repository<Department>,
    systemRepo as unknown as Repository<System>,
    equipmentRepo as unknown as Repository<Equipment>,
    equipmentSystemRepo as unknown as Repository<EquipmentSystem>,
    tankRepo as unknown as Repository<Tank>,
  );
  return { handler, equipmentSystemFind };
}

const SITE_ID = 'site-1';
const TENANT = 'tenant-1';

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
      handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT)),
    ).rejects.toThrow(NotFoundException);
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

    const response = await handler.execute(
      new GetSiteDeletePreviewQuery(SITE_ID, TENANT),
    );

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

    const response = await handler.execute(
      new GetSiteDeletePreviewQuery(SITE_ID, TENANT),
    );
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

    const response = await handler.execute(
      new GetSiteDeletePreviewQuery(SITE_ID, TENANT),
    );
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

    await handler.execute(new GetSiteDeletePreviewQuery(SITE_ID, TENANT));
    // Avoids an empty-IN query — match the handler's guard.
    expect(equipmentSystemFind).not.toHaveBeenCalled();
  });

  it('reports a blocker when tanks contain active biomass', async () => {
    const { handler } = makeHandler({
      site: { id: SITE_ID, tenantId: TENANT, name: 'Site-1' },
      departments: [{ id: 'dept-1', tenantId: TENANT, name: 'D1', code: 'D1' }],
      systems: [],
      tanks: [
        {
          id: 't1',
          tenantId: TENANT,
          departmentId: 'dept-1',
          name: 'T1',
          code: 'T1',
          currentBiomass: '450',
        } as unknown as Tank,
      ],
      equipment: [],
      equipmentSystemLinks: [],
    });

    const response = await handler.execute(
      new GetSiteDeletePreviewQuery(SITE_ID, TENANT),
    );
    expect(response.canDelete).toBe(false);
    expect(response.blockers[0]).toContain('450.00 kg');
  });
});
