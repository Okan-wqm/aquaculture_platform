/**
 * GetSparePartCriticalityHandler — argument handling and result mapping
 * (FARM-24). London school: the EntityManager is a double, so these cases pin
 * what the handler SENDS and how it SHAPES rows. The SQL semantics are proven
 * against real Postgres in `__tests__/e2e/spare-part-criticality.postgres.spec.ts`.
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';

import { EquipmentStatus } from '../../equipment/entities/equipment.entity';
import { GetSparePartCriticalityHandler } from '../handlers/get-spare-part-criticality.handler';
import { GetSparePartCriticalityQuery } from '../queries/get-spare-part-criticality.query';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PART = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TYPE_A = 'a0000000-0000-4000-8000-00000000000a';
const TYPE_B = 'b0000000-0000-4000-8000-00000000000b';

function setup(
  sparePart: object | null,
  rows: object[] = [],
): {
  handler: GetSparePartCriticalityHandler;
  findOne: jest.Mock;
  query: jest.Mock;
} {
  const { mockDataSource, mockManager } = createMockDataSource();
  const findOne = jest.fn().mockResolvedValue(sparePart);
  const query = jest.fn().mockResolvedValue(rows);
  Object.assign(mockManager, { findOne, query });
  return { handler: new GetSparePartCriticalityHandler(mockDataSource), findOne, query };
}

function run(
  handler: GetSparePartCriticalityHandler,
): ReturnType<GetSparePartCriticalityHandler['execute']> {
  return handler.execute(new GetSparePartCriticalityQuery(TENANT, PART, SITE));
}

describe('GetSparePartCriticalityHandler', () => {
  it('throws NotFound for a part the tenant does not own and never scans', async () => {
    // SCENARIO: the tenant-scoped part lookup finds nothing.
    // EXPECTS: NotFoundException; the lookup carried tenantId; no criticality SQL ran.
    const { handler, findOne, query } = setup(null);

    await expect(run(handler)).rejects.toBeInstanceOf(NotFoundException);
    expect(findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: PART, tenantId: TENANT },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('returns an empty result without scanning when the part fits no type', async () => {
    // SCENARIO: equipmentTypeId NULL and no compatible list.
    // EXPECTS: null level, empty id lists, no SQL round-trip.
    const { handler, query } = setup({
      id: PART,
      equipmentTypeId: null,
      compatibleEquipmentTypes: [],
    });

    await expect(run(handler)).resolves.toEqual({
      sparePartId: PART,
      siteId: SITE,
      maxCriticalityLevel: null,
      contributingEquipmentIds: [],
      contributingSystemIds: [],
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('sends the single equipmentTypeId and ignores the compatible list when it is set', async () => {
    // SCENARIO: both fields populated.
    // EXPECTS: params = tenant, site, [single type], DECOMMISSIONED, backup-ready statuses, 'backup'.
    const { handler, query } = setup({
      id: PART,
      equipmentTypeId: TYPE_A,
      compatibleEquipmentTypes: [TYPE_B],
    });

    await run(handler);

    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([
      TENANT,
      SITE,
      [TYPE_A],
      EquipmentStatus.DECOMMISSIONED,
      [EquipmentStatus.OPERATIONAL, EquipmentStatus.STANDBY],
      'backup',
    ]);
    expect(sql).toContain('es."tenantId" = $1');
    expect(sql).toContain('tb."tenantId" = $1');
    expect(sql).toContain('bes."tenantId" = $1');
  });

  it('falls back to the de-duplicated compatible list when equipmentTypeId is NULL', async () => {
    // SCENARIO: equipmentTypeId NULL, compatible list with a duplicate.
    // EXPECTS: the distinct list is the type parameter.
    const { handler, query } = setup({
      id: PART,
      equipmentTypeId: null,
      compatibleEquipmentTypes: [TYPE_A, TYPE_B, TYPE_A],
    });

    await run(handler);

    expect(query.mock.calls[0][1][2]).toEqual([TYPE_A, TYPE_B]);
  });

  it('maps qualifying rows to the max level and distinct, sorted evidence ids', async () => {
    // SCENARIO: three qualifying links; one equipment serves two systems.
    // EXPECTS: max 5; each id once, sorted; every contributor kept, not only the max row.
    const { handler } = setup({ id: PART, equipmentTypeId: TYPE_A }, [
      { equipmentId: 'e-2', systemId: 's-1', criticalityLevel: 3 },
      { equipmentId: 'e-1', systemId: 's-2', criticalityLevel: 5 },
      { equipmentId: 'e-2', systemId: 's-2', criticalityLevel: 4 },
    ]);

    await expect(run(handler)).resolves.toEqual({
      sparePartId: PART,
      siteId: SITE,
      maxCriticalityLevel: 5,
      contributingEquipmentIds: ['e-1', 'e-2'],
      contributingSystemIds: ['s-1', 's-2'],
    });
  });

  it('returns a null level when the scan finds no qualifying link', async () => {
    // SCENARIO: compatible part, scan returns no rows.
    // EXPECTS: null level and empty lists — "not critical", not zero.
    const { handler } = setup({ id: PART, equipmentTypeId: TYPE_A }, []);

    const result = await run(handler);

    expect(result.maxCriticalityLevel).toBeNull();
    expect(result.contributingEquipmentIds).toEqual([]);
    expect(result.contributingSystemIds).toEqual([]);
  });
});
