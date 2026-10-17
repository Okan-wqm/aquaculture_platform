const mockFindTankOrEquipment = jest.fn();
const mockResolveSite = jest.fn();
const mockResolveUnitSites = jest.fn();
jest.mock('../../../batch/utils/tank-lookup.util', () => ({
  findTankOrEquipmentWithManager: (...args: unknown[]): unknown => mockFindTankOrEquipment(...args),
  resolveSiteIdFromDepartment: (...args: unknown[]): unknown => mockResolveSite(...args),
  resolveUnitSiteIds: (...args: unknown[]): unknown => mockResolveUnitSites(...args),
}));

import { stub, stubMember } from '@aquaculture/testing';
import { type EntityManager, type EntityTarget, In } from 'typeorm';

import { Equipment } from '../../../equipment/entities/equipment.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import {
  measurementUnitColumns,
  resolveMeasurementUnit,
  resolveMeasurementUnits,
} from '../measurement-unit';

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';

/** Farm classifies the one unit id a client sends: a tank's id, or equipment. */
describe('resolveMeasurementUnit', () => {
  const manager = stub<EntityManager>({});

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSite.mockResolvedValue(SITE);
  });

  it('classifies a tanks-table row, and a legacy isTank equipment row, as a tank', async () => {
    mockFindTankOrEquipment.mockResolvedValue({
      isFromTanksTable: true,
      equipment: { departmentId: 'd1', isTank: true },
    });
    expect(await resolveMeasurementUnit(manager, UNIT, TENANT)).toEqual({
      kind: 'tank',
      id: UNIT,
      siteId: SITE,
    });
    mockFindTankOrEquipment.mockResolvedValue({
      isFromTanksTable: false,
      equipment: { departmentId: 'd1', isTank: true },
    });
    expect((await resolveMeasurementUnit(manager, UNIT, TENANT))?.kind).toBe('tank');
  });

  it('classifies other water equipment as equipment, with its department’s site', async () => {
    mockFindTankOrEquipment.mockResolvedValue({
      isFromTanksTable: false,
      equipment: { departmentId: 'd2', isTank: false },
    });
    expect(await resolveMeasurementUnit(manager, UNIT, TENANT)).toEqual({
      kind: 'equipment',
      id: UNIT,
      siteId: SITE,
    });
    expect(mockResolveSite).toHaveBeenCalledWith(manager, 'd2', TENANT);
  });

  it('answers null for no active unit', async () => {
    mockFindTankOrEquipment.mockResolvedValue(null);
    expect(await resolveMeasurementUnit(manager, UNIT, TENANT)).toBeNull();
  });
});

/**
 * The many-unit classifier reads the units through the tenant-scoped
 * repository (every where carries the tenant) and takes their sites from the
 * one bulk unit-site lookup, the rule a single point's read authorizes by.
 */
describe('resolveMeasurementUnits', () => {
  const EQUIPMENT_TANK = '44444444-4444-4444-8444-444444444444';
  const BIOFILTER = '55555555-5555-4555-8555-555555555555';
  const LEGACY_TANK = '66666666-6666-4666-8666-666666666666';
  const RETIRED = '77777777-7777-4777-8777-777777777777';
  const SITELESS = '88888888-8888-4888-8888-888888888888';

  let finds: { entity: unknown; options: unknown }[];
  let manager: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    finds = [];
    const rows = new Map<unknown, unknown[]>([
      [
        Equipment,
        [
          { id: EQUIPMENT_TANK, isTank: true },
          { id: BIOFILTER, isTank: false },
        ],
      ],
      [Tank, [{ id: LEGACY_TANK }, { id: SITELESS }]],
    ]);
    const repository = (entity: EntityTarget<unknown>): unknown => ({
      metadata: { findColumnWithPropertyName: () => ({ databaseName: 'tenantId' }) },
      find: async (options: unknown): Promise<unknown[]> => {
        finds.push({ entity, options });
        return rows.get(entity) ?? [];
      },
    });
    manager = stub<EntityManager>({
      getRepository: stubMember<EntityManager['getRepository']>(repository),
    });
    mockResolveUnitSites.mockResolvedValue(
      new Map([
        [EQUIPMENT_TANK, SITE],
        [BIOFILTER, SITE],
        [LEGACY_TANK, SITE],
      ]),
    );
  });

  it('classifies each active unit and takes its site from resolveUnitSiteIds; an inactive id is absent', async () => {
    const units = await resolveMeasurementUnits(
      manager,
      [EQUIPMENT_TANK, BIOFILTER, LEGACY_TANK, RETIRED, SITELESS],
      TENANT,
    );
    expect([...units.values()]).toEqual([
      { kind: 'tank', id: EQUIPMENT_TANK, siteId: SITE },
      { kind: 'equipment', id: BIOFILTER, siteId: SITE },
      { kind: 'tank', id: LEGACY_TANK, siteId: SITE },
      { kind: 'tank', id: SITELESS, siteId: null },
    ]);
    expect(units.has(RETIRED)).toBe(false);
    expect(mockResolveUnitSites).toHaveBeenCalledTimes(1);
    expect(mockResolveUnitSites).toHaveBeenCalledWith(
      manager,
      [EQUIPMENT_TANK, BIOFILTER, LEGACY_TANK, SITELESS],
      TENANT,
    );
  });

  it('reads equipment, then only the ids it did not find as legacy tanks, each scoped to the tenant', async () => {
    await resolveMeasurementUnits(manager, [EQUIPMENT_TANK, BIOFILTER, LEGACY_TANK], TENANT);
    expect(finds).toEqual([
      {
        entity: Equipment,
        options: expect.objectContaining({
          where: {
            id: In([EQUIPMENT_TANK, BIOFILTER, LEGACY_TANK]),
            isActive: true,
            isDeleted: false,
            tenantId: TENANT,
          },
        }),
      },
      {
        entity: Tank,
        options: expect.objectContaining({
          where: { id: In([LEGACY_TANK]), isActive: true, tenantId: TENANT },
        }),
      },
    ]);
  });

  it('asks nothing for no units', async () => {
    expect((await resolveMeasurementUnits(manager, [], TENANT)).size).toBe(0);
    expect(finds).toEqual([]);
    expect(mockResolveUnitSites).not.toHaveBeenCalled();
  });
});

describe('measurementUnitColumns', () => {
  it('fills exactly one column', () => {
    expect(measurementUnitColumns({ kind: 'tank', id: UNIT, siteId: null })).toEqual({
      tankId: UNIT,
      equipmentId: undefined,
    });
    expect(measurementUnitColumns({ kind: 'equipment', id: UNIT, siteId: null })).toEqual({
      tankId: undefined,
      equipmentId: UNIT,
    });
    expect(measurementUnitColumns(null)).toEqual({ tankId: undefined, equipmentId: undefined });
  });
});
