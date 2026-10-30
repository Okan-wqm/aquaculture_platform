import 'reflect-metadata';

const mockRunInTenantRead = jest.fn();
jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (...args: unknown[]): unknown => mockRunInTenantRead(...args),
}));
const mockFindTankOrEquipment = jest.fn();
jest.mock('../../batch/utils/tank-lookup.util', () => ({
  findTankOrEquipmentWithManager: (...args: unknown[]): unknown => mockFindTankOrEquipment(...args),
}));
const mockLoadFarmArrangement = jest.fn();
jest.mock('../../water-quality/services/channel-placement', () => ({
  loadFarmArrangement: (...args: unknown[]): unknown => mockLoadFarmArrangement(...args),
}));

import { createMockDataSource } from '@aquaculture/testing';
import { Test } from '@nestjs/testing';
import { NatsRequestReply } from '@platform/event-bus';
import { FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

import { Department } from '../../department/entities/department.entity';
import { System } from '../../system/entities/system.entity';
import { Site } from '../entities/site.entity';

import {
  FarmDevicePlacementAuthorityUnavailableError,
  FarmDevicePlacementRequestInvalidError,
  loadDevicePlacementFacts,
  ResolveDevicePlacementResponder,
} from './resolve-device-placement.responder';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT_ID = '33333333-3333-4333-8333-333333333333';
const SYSTEM_ID = '44444444-4444-4444-8444-444444444444';
const UNIT_ID = '55555555-5555-4555-8555-555555555555';

describe('ResolveDevicePlacementResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest.fn().mockResolvedValue({
    subject: FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS.RESOLVE,
    drain,
  });
  let responder: ResolveDevicePlacementResponder;

  beforeEach(async () => {
    jest.clearAllMocks();
    const { mockDataSource } = createMockDataSource();
    const module = await Test.createTestingModule({
      providers: [
        ResolveDevicePlacementResponder,
        { provide: DataSource, useValue: mockDataSource },
        { provide: NatsRequestReply, useValue: { respond } },
      ],
    }).compile();
    responder = module.get(ResolveDevicePlacementResponder);
  });

  it('registers and drains the shared request subject', async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      FARM_DEVICE_PLACEMENT_QUERY_SUBJECTS.RESOLVE,
      expect.any(Function),
      { queue: 'farm-service' },
    );
    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('refuses a request outside the contract without reading the tenant', async () => {
    await expect(
      responder.resolve({
        tenantId: 'not-a-uuid',
        siteId: SITE_ID,
        departmentId: null,
        systemId: null,
        unitId: null,
      }),
    ).rejects.toBeInstanceOf(FarmDevicePlacementRequestInvalidError);
    expect(mockRunInTenantRead).not.toHaveBeenCalled();
  });

  it('reads the facts inside the requested tenant and judges them', async () => {
    mockRunInTenantRead.mockResolvedValue({
      siteLive: true,
      department: null,
      system: null,
      unit: null,
    });
    await expect(
      responder.resolve({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        departmentId: null,
        systemId: null,
        unitId: null,
      }),
    ).resolves.toEqual({ placeable: true, unitKind: null });
    expect(mockRunInTenantRead).toHaveBeenCalledWith(
      expect.anything(),
      'farm',
      TENANT_ID,
      expect.any(Function),
    );
  });

  it('fails closed with a distinct error when the farm read fails', async () => {
    mockRunInTenantRead.mockRejectedValue(new Error('connection lost'));
    await expect(
      responder.resolve({
        tenantId: TENANT_ID,
        siteId: SITE_ID,
        departmentId: null,
        systemId: null,
        unitId: null,
      }),
    ).rejects.toBeInstanceOf(FarmDevicePlacementAuthorityUnavailableError);
  });
});

describe('loadDevicePlacementFacts', () => {
  const { mockManager: manager } = createMockDataSource();
  const findOne = manager.findOne;
  const rows = new Map<unknown, unknown>([
    [Site, { id: SITE_ID }],
    [Department, { id: DEPARTMENT_ID, siteId: SITE_ID }],
    [System, { id: SYSTEM_ID, siteId: SITE_ID, departmentId: null }],
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    findOne.mockImplementation(async (entity: unknown) => rows.get(entity) ?? null);
    mockLoadFarmArrangement.mockResolvedValue({
      systemsOfUnit: new Map([[UNIT_ID, new Set([SYSTEM_ID])]]),
      siteOfUnit: new Map([[UNIT_ID, SITE_ID]]),
      siteOfSystem: new Map(),
      typeOfSystem: new Map(),
    });
  });

  it('reads only live rows of the tenant for each named level', async () => {
    mockFindTankOrEquipment.mockResolvedValue({
      equipment: { id: UNIT_ID, isTank: true, departmentId: DEPARTMENT_ID },
      isFromTanksTable: false,
    });
    const facts = await loadDevicePlacementFacts(manager, {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      departmentId: DEPARTMENT_ID,
      systemId: SYSTEM_ID,
      unitId: UNIT_ID,
    });
    for (const entity of [Site, Department, System]) {
      expect(findOne).toHaveBeenCalledWith(
        entity,
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT_ID, isActive: true, isDeleted: false }),
        }),
      );
    }
    expect(facts).toEqual({
      siteLive: true,
      department: { siteId: SITE_ID },
      system: { siteId: SITE_ID, departmentId: null },
      unit: {
        kind: 'TANK',
        departmentId: DEPARTMENT_ID,
        systemIds: new Set([SYSTEM_ID]),
      },
    });
  });

  it('calls equipment that is not a tank EQUIPMENT, and a legacy tanks row a TANK', async () => {
    const place = {
      tenantId: TENANT_ID,
      siteId: SITE_ID,
      departmentId: null,
      systemId: null,
      unitId: UNIT_ID,
    };
    mockFindTankOrEquipment.mockResolvedValueOnce({
      equipment: { id: UNIT_ID, isTank: false, departmentId: DEPARTMENT_ID },
      isFromTanksTable: false,
    });
    expect((await loadDevicePlacementFacts(manager, place)).unit?.kind).toBe('EQUIPMENT');
    mockFindTankOrEquipment.mockResolvedValueOnce({
      equipment: { id: UNIT_ID, isTank: false, departmentId: DEPARTMENT_ID },
      isFromTanksTable: true,
    });
    expect((await loadDevicePlacementFacts(manager, place)).unit?.kind).toBe('TANK');
  });

  it('reads a level named by a non-uuid as absent, without a query', async () => {
    const facts = await loadDevicePlacementFacts(manager, {
      tenantId: TENANT_ID,
      siteId: 'site; drop',
      departmentId: null,
      systemId: null,
      unitId: 'unit',
    });
    expect(findOne).not.toHaveBeenCalled();
    expect(mockFindTankOrEquipment).not.toHaveBeenCalled();
    expect(facts.siteLive).toBe(false);
    expect(facts.unit).toBeNull();
  });
});
