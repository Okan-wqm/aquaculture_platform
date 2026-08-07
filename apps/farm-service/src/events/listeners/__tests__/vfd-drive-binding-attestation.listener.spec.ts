/**
 * farm-service answering "what is the equipment this drive turns?".
 *
 * The claims under test are the ones a drive acts on: the CATEGORY (feeder vs
 * pump vs blower), whether the row exists and is in service at all, and — for a
 * feeder only — the units it currently serves. Everything else about the
 * attestation is plumbing.
 */
import { createBaseEvent } from '@platform/event-contracts';
import type {
  BaseEvent,
  VfdDriveBindingAttestationRequestedEvent,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';

import {
  EquipmentCategory,
  EquipmentType,
} from '../../../equipment/entities/equipment-type.entity';
import { Equipment } from '../../../equipment/entities/equipment.entity';
import { FeederAssignment } from '../../../feeding-protocol/entities/feeder-assignment.entity';

/** Rows the fake data layer serves, set per test. */
const store: {
  equipment: Partial<Equipment> | null;
  equipmentType: Partial<EquipmentType> | null;
  assignments: Array<Partial<FeederAssignment>>;
  siteId: string | null;
} = { equipment: null, equipmentType: null, assignments: [], siteId: null };

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantRead: (
    _ds: unknown,
    _schema: string,
    _tenantId: string,
    cb: (qr: { manager: { findOne(entity: unknown): Promise<unknown> } }) => Promise<unknown>,
  ) =>
    cb({
      manager: {
        findOne: async (entity: unknown) => (entity === EquipmentType ? store.equipmentType : null),
      },
    }),
  tenantManagerRepo: (_manager: unknown, entity: unknown) => ({
    findOne: async () => (entity === Equipment ? store.equipment : null),
    find: async () => (entity === FeederAssignment ? store.assignments : []),
  }),
}));

jest.mock('../../../batch/utils/tank-lookup.util', () => ({
  ...jest.requireActual('../../../batch/utils/tank-lookup.util'),
  resolveSiteIdFromDepartment: async () => store.siteId,
}));

import { VfdDriveBindingAttestationListener } from '../vfd-drive-binding-attestation.listener';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const DRIVE = 'bbbbbbbb-2222-4333-8444-555555555555';
const EQUIPMENT = 'cccccccc-3333-4444-8555-666666666666';
const TANK = 'dddddddd-4444-4555-8666-777777777777';

function request(): VfdDriveBindingAttestationRequestedEvent {
  return {
    ...createBaseEvent<VfdDriveBindingAttestationRequestedEvent>(
      'VfdDriveBindingAttestationRequested',
      TENANT,
      { aggregateId: DRIVE, aggregateType: 'VfdDevice' },
    ),
    vfdDeviceId: DRIVE,
    drivenEquipmentId: EQUIPMENT,
  };
}

describe('VfdDriveBindingAttestationListener', () => {
  let published: Array<Record<string, unknown>>;
  let listener: VfdDriveBindingAttestationListener;

  beforeEach(async () => {
    store.equipment = null;
    store.equipmentType = null;
    store.assignments = [];
    store.siteId = null;
    published = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdDriveBindingAttestationListener,
        { provide: DataSource, useValue: {} },
        {
          provide: 'EVENT_BUS',
          useValue: {
            publish: async (event: Record<string, unknown>): Promise<void> => {
              published.push(event);
            },
          },
        },
      ],
    }).compile();

    listener = module.get<VfdDriveBindingAttestationListener>(VfdDriveBindingAttestationListener);
  });

  it('attests a pump with its category and NO units — a pump serves none', async () => {
    store.equipment = {
      id: EQUIPMENT,
      code: 'P-1',
      name: 'Inlet pump',
      isActive: true,
      equipmentTypeId: 'type-p',
    };
    store.equipmentType = { id: 'type-p', category: EquipmentCategory.PUMP };

    await listener.handle(request());

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      eventType: 'VfdDriveBindingAttested',
      vfdDeviceId: DRIVE,
      drivenEquipmentId: EQUIPMENT,
      outcome: 'attested',
      equipmentCategory: EquipmentCategory.PUMP,
      equipmentCode: 'P-1',
      servedUnits: [],
    });
  });

  it('attests a blower with NO units', async () => {
    store.equipment = {
      id: EQUIPMENT,
      code: 'B-1',
      name: 'Blower',
      isActive: true,
      equipmentTypeId: 'type-b',
    };
    store.equipmentType = { id: 'type-b', category: EquipmentCategory.AERATION };
    // Even if assignment rows somehow existed, a non-feeder must not carry units.
    store.assignments = [
      {
        unitId: TANK,
        unitType: 'tank',
        unitCode: 'T-1',
        doseSharePercent: 100,
      } as Partial<FeederAssignment>,
    ];

    await listener.handle(request());

    expect(published[0]).toMatchObject({
      equipmentCategory: EquipmentCategory.AERATION,
      servedUnits: [],
    });
  });

  it('attests a feeder WITH the units its active assignments name', async () => {
    store.equipment = {
      id: EQUIPMENT,
      code: 'F-1',
      name: 'Feeder 1',
      isActive: true,
      equipmentTypeId: 'type-f',
    };
    store.equipmentType = { id: 'type-f', category: EquipmentCategory.FEEDING };
    store.siteId = 'site-1';
    store.assignments = [
      {
        unitId: TANK,
        unitType: 'tank',
        unitCode: 'T-1',
        doseSharePercent: 100,
      } as Partial<FeederAssignment>,
    ];

    await listener.handle(request());

    expect(published[0]).toMatchObject({
      outcome: 'attested',
      equipmentCategory: EquipmentCategory.FEEDING,
      siteId: 'site-1',
      servedUnits: [{ unitId: TANK, unitType: 'tank', unitCode: 'T-1', doseSharePercent: 100 }],
    });
  });

  it('reports unknown_equipment when the row does not exist (or was deleted)', async () => {
    store.equipment = null;

    await listener.handle(request());

    expect(published[0]).toMatchObject({ outcome: 'unknown_equipment', servedUnits: [] });
  });

  it('reports inactive_equipment rather than attesting something out of service', async () => {
    store.equipment = {
      id: EQUIPMENT,
      code: 'F-2',
      name: 'Retired feeder',
      isActive: false,
      equipmentTypeId: 'type-f',
    };
    store.equipmentType = { id: 'type-f', category: EquipmentCategory.FEEDING };
    store.assignments = [
      {
        unitId: TANK,
        unitType: 'tank',
        unitCode: 'T-1',
        doseSharePercent: 100,
      } as Partial<FeederAssignment>,
    ];

    await listener.handle(request());

    expect(published[0]).toMatchObject({ outcome: 'inactive_equipment', servedUnits: [] });
  });

  it('answers nothing for a request whose shape it cannot trust', async () => {
    store.equipment = {
      id: EQUIPMENT,
      code: 'P-1',
      name: 'Inlet pump',
      isActive: true,
      equipmentTypeId: 'type-p',
    };
    store.equipmentType = { id: 'type-p', category: EquipmentCategory.PUMP };
    // A drive id that is not a uuid satisfies the static type; only the wire
    // schema catches it, and a malformed id must not reach the equipment lookup.
    const malformed: VfdDriveBindingAttestationRequestedEvent = {
      ...request(),
      vfdDeviceId: 'not-a-uuid',
    };

    await listener.handle(malformed);

    expect(published).toHaveLength(0);
  });

  it('answers nothing for a request whose tenant cannot be trusted', async () => {
    const malformed = { ...request(), tenantId: 'not-a-uuid' } as BaseEvent;

    await listener.handle(malformed);

    expect(published).toHaveLength(0);
  });
});
