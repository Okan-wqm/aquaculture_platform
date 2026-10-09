const mockFindTankOrEquipment = jest.fn();
const mockResolveSite = jest.fn();
jest.mock('../../../batch/utils/tank-lookup.util', () => ({
  findTankOrEquipmentWithManager: (...args: unknown[]): unknown => mockFindTankOrEquipment(...args),
  resolveSiteIdFromDepartment: (...args: unknown[]): unknown => mockResolveSite(...args),
}));

import { stub } from '@aquaculture/testing';
import type { EntityManager } from 'typeorm';

import { measurementUnitColumns, resolveMeasurementUnit } from '../measurement-unit';

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
