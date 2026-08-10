/**
 * What a drive turns, and what unit follows from it.
 *
 * These tests run the real service against in-memory stand-ins for its two
 * repositories. The stand-ins STORE — they are not `jest.fn()` returning canned
 * answers — because every claim here is about state the service reads back after
 * writing it. A test that stubbed `findOne` would prove only that the stub was
 * called, which is exactly how a dead feature keeps a green spec.
 *
 * The doubles are wired through Nest's `useValue`, which is why nothing here
 * needs a type assertion: the container accepts a structural stand-in, so the
 * fake stays an honest plain object.
 */
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { VfdDriveBinding, VfdDriveBindingState } from '../../entities/vfd-drive-binding.entity';
import { VfdDriveBindingUnit } from '../../entities/vfd-drive-binding-unit.entity';
import {
  ATTESTATION_MAX_AGE_MS,
  ATTESTATION_REQUEST_MIN_INTERVAL_MS,
  VfdDriveBindingService,
} from '../vfd-drive-binding.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DRIVE = '22222222-2222-4222-8222-222222222222';
const FEEDER = '33333333-3333-4333-8333-333333333333';
const PUMP = '44444444-4444-4444-8444-444444444444';
const TANK_A = '55555555-5555-4555-8555-555555555555';
const TANK_B = '66666666-6666-4666-8666-666666666666';

type Row = Record<string, unknown>;

/** Minimal matcher for the `where` shapes this service actually uses. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    // TypeORM's In(...) operator, as constructed by the service.
    if (expected !== null && typeof expected === 'object' && '_value' in expected) {
      const values = Reflect.get(expected, '_value');
      return Array.isArray(values) && values.includes(row[key]);
    }
    return row[key] === expected;
  });
}

interface InMemoryRepository {
  rows: Map<string, Row>;
  create(dto: Row): Row;
  save(input: Row | Row[]): Promise<Row | Row[]>;
  findOne(options: { where: Row }): Promise<Row | null>;
  find(options?: { where?: Row; order?: Record<string, 'ASC' | 'DESC'> }): Promise<Row[]>;
  delete(where: Row): Promise<{ affected: number }>;
}

function inMemoryRepository(keyOf: (row: Row) => string): InMemoryRepository {
  const rows = new Map<string, Row>();
  return {
    rows,
    create: (dto) => ({ ...dto }),
    save: async (input) => {
      for (const row of Array.isArray(input) ? input : [input]) {
        rows.set(keyOf(row), { ...row });
      }
      return input;
    },
    findOne: async ({ where }) => [...rows.values()].find((row) => matches(row, where)) ?? null,
    find: async (options) => {
      const found = [...rows.values()].filter((row) => matches(row, options?.where ?? {}));
      const order = options?.order;
      if (order) {
        const [field, direction] = Object.entries(order)[0]!;
        found.sort((a, b) => {
          const left = String(a[field]);
          const right = String(b[field]);
          const cmp = left < right ? -1 : left > right ? 1 : 0;
          return direction === 'DESC' ? -cmp : cmp;
        });
      }
      return found;
    },
    delete: async (where) => {
      let affected = 0;
      for (const [key, row] of [...rows.entries()]) {
        if (matches(row, where)) {
          rows.delete(key);
          affected += 1;
        }
      }
      return { affected };
    },
  };
}

describe('VfdDriveBindingService', () => {
  let bindings: InMemoryRepository;
  let units: InMemoryRepository;
  let published: Row[];
  let service: VfdDriveBindingService;

  beforeEach(async () => {
    bindings = inMemoryRepository((row) => String(row['vfdDeviceId']));
    units = inMemoryRepository((row) => `${String(row['vfdDeviceId'])}:${String(row['unitId'])}`);
    published = [];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdDriveBindingService,
        { provide: getRepositoryToken(VfdDriveBinding), useValue: bindings },
        { provide: getRepositoryToken(VfdDriveBindingUnit), useValue: units },
        {
          provide: 'EVENT_BUS',
          useValue: {
            publish: async (event: Row): Promise<void> => {
              published.push(event);
            },
          },
        },
      ],
    }).compile();

    service = module.get<VfdDriveBindingService>(VfdDriveBindingService);
  });

  /** Bind + attest, as the listener would after farm-service answered. */
  async function bindAndAttest(
    equipmentId: string,
    category: string,
    servedUnits: Array<{ unitId: string; unitCode: string; doseSharePercent: number }> = [],
    attestedAt: Date = new Date(),
  ): Promise<void> {
    await service.bind(DRIVE, TENANT, equipmentId);
    await service.applyAttestation({
      vfdDeviceId: DRIVE,
      tenantId: TENANT,
      drivenEquipmentId: equipmentId,
      outcome: 'attested',
      equipmentCategory: category,
      equipmentCode: 'EQ-1',
      equipmentName: 'Equipment 1',
      servedUnits: servedUnits.map((unit) => ({ ...unit, unitType: 'tank' })),
      attestedAt,
    });
  }

  describe('a drive on something that is not a feeder', () => {
    it('implies NO unit when it drives a pump, and that is the answer, not a failure', async () => {
      await bindAndAttest(PUMP, 'pump');

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);

      expect(resolution.kind).toBe('not_a_feeder');
      expect(resolution).not.toHaveProperty('unit');
      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(0);
    });

    it('implies NO unit when it drives a blower', async () => {
      await bindAndAttest(PUMP, 'aeration');

      expect((await service.resolveDrivenUnit(DRIVE, TENANT)).kind).toBe('not_a_feeder');
    });

    it('still actuates — a pump serves no unit but is perfectly commandable', async () => {
      await bindAndAttest(PUMP, 'pump');

      await expect(service.assertActuable(DRIVE, TENANT)).resolves.toBeUndefined();
    });
  });

  describe('a drive on a feeder', () => {
    it('derives the unit through the feeder assignment', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 100 },
      ]);

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);

      expect(resolution).toEqual({
        kind: 'feeder_unit',
        drivenEquipmentId: FEEDER,
        unit: {
          unitId: TANK_A,
          unitType: 'tank',
          unitCode: 'T-A',
          doseSharePercent: 100,
        },
      });
    });

    it('refuses to pick one when the feeder serves several units', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 60 },
        { unitId: TANK_B, unitCode: 'T-B', doseSharePercent: 40 },
      ]);

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);

      expect(resolution.kind).toBe('feeder_ambiguous');
      expect(resolution).not.toHaveProperty('unit');
    });

    it('is found by the unit it serves', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 100 },
      ]);

      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(1);
    });
  });

  describe('an unbound drive', () => {
    it('resolves to unbound rather than to a null unit', async () => {
      expect(await service.resolveDrivenUnit(DRIVE, TENANT)).toEqual({ kind: 'unbound' });
    });

    it('fails closed: it cannot be commanded', async () => {
      await expect(service.assertActuable(DRIVE, TENANT)).rejects.toThrow(BadRequestException);
    });
  });

  describe('a binding nobody has confirmed yet', () => {
    it('is PENDING and asks its owner', async () => {
      await service.bind(DRIVE, TENANT, FEEDER);

      expect(bindings.rows.get(DRIVE)?.['state']).toBe(VfdDriveBindingState.PENDING);
      expect(published).toEqual([
        expect.objectContaining({
          eventType: 'VfdDriveBindingAttestationRequested',
          vfdDeviceId: DRIVE,
          drivenEquipmentId: FEEDER,
        }),
      ]);
    });

    it('fails closed: PENDING cannot be commanded', async () => {
      await service.bind(DRIVE, TENANT, FEEDER);

      await expect(service.assertActuable(DRIVE, TENANT)).rejects.toThrow(/has not confirmed/);
    });
  });

  describe('a stale binding', () => {
    it('does not actuate once the equipment is deleted', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 100 },
      ]);
      await expect(service.assertActuable(DRIVE, TENANT)).resolves.toBeUndefined();

      const revoked = await service.revokeForEquipment(TENANT, FEEDER);

      expect(revoked).toBe(1);
      expect(bindings.rows.get(DRIVE)?.['state']).toBe(VfdDriveBindingState.UNKNOWN_EQUIPMENT);
      // The unit goes with it: a drive must not keep claiming a tank through
      // equipment that no longer exists.
      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(0);
      await expect(service.assertActuable(DRIVE, TENANT)).rejects.toThrow(BadRequestException);
    });

    it('does not actuate once the attestation ages out', async () => {
      const longAgo = new Date(Date.now() - ATTESTATION_MAX_AGE_MS - 60_000);
      await bindAndAttest(PUMP, 'pump', [], longAgo);

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);

      expect(resolution.kind).toBe('expired');
      await expect(service.assertActuable(DRIVE, TENANT)).rejects.toThrow(/aged out/);
    });

    it('loses the unit when the feeder assignment ends', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 100 },
      ]);

      // The unit's feeder set is republished WITHOUT this feeder — an ended
      // assignment. The drive must stop claiming the tank.
      await service.applyUnitFeederSet({
        tenantId: TENANT,
        unitId: TANK_A,
        unitType: 'tank',
        unitCode: 'T-A',
        feeders: [],
      });

      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(0);
      expect((await service.resolveDrivenUnit(DRIVE, TENANT)).kind).toBe('feeder_without_unit');
    });

    it('gains the unit when the feeder is assigned to one', async () => {
      await bindAndAttest(FEEDER, 'feeding');
      expect((await service.resolveDrivenUnit(DRIVE, TENANT)).kind).toBe('feeder_without_unit');

      await service.applyUnitFeederSet({
        tenantId: TENANT,
        unitId: TANK_B,
        unitType: 'cage',
        unitCode: 'C-B',
        feeders: [{ feederEquipmentId: FEEDER, doseSharePercent: 100 }],
      });

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);
      expect(resolution).toMatchObject({
        kind: 'feeder_unit',
        unit: { unitId: TANK_B, unitCode: 'C-B', unitType: 'cage' },
      });
    });
  });

  describe('re-binding', () => {
    it('drops the previous equipment’s units, so a feeder→pump move cannot keep feeding a tank', async () => {
      await bindAndAttest(FEEDER, 'feeding', [
        { unitId: TANK_A, unitCode: 'T-A', doseSharePercent: 100 },
      ]);

      await service.bind(DRIVE, TENANT, PUMP);

      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(0);
      expect(bindings.rows.get(DRIVE)?.['state']).toBe(VfdDriveBindingState.PENDING);
      expect(bindings.rows.get(DRIVE)?.['attestedAt']).toBeUndefined();
    });

    it('discards an answer about equipment the drive is no longer pointed at', async () => {
      await service.bind(DRIVE, TENANT, PUMP);

      // A late answer about the OLD equipment must not resurrect it.
      await service.applyAttestation({
        vfdDeviceId: DRIVE,
        tenantId: TENANT,
        drivenEquipmentId: FEEDER,
        outcome: 'attested',
        equipmentCategory: 'feeding',
        servedUnits: [{ unitId: TANK_A, unitType: 'tank', unitCode: 'T-A', doseSharePercent: 100 }],
        attestedAt: new Date(),
      });

      expect(bindings.rows.get(DRIVE)?.['state']).toBe(VfdDriveBindingState.PENDING);
      expect(await service.findUnits(DRIVE, TENANT)).toHaveLength(0);
    });
  });

  describe('self-healing', () => {
    it('re-asks when it holds no confirmation, rate-limited so a mute owner is not flooded', async () => {
      await service.bind(DRIVE, TENANT, FEEDER);
      expect(published).toHaveLength(1);

      // Immediately after the bind the floor has not elapsed: no second question.
      await service.resolveDrivenUnit(DRIVE, TENANT);
      expect(published).toHaveLength(1);

      // Once it has, the drive asks again on its own.
      const binding = bindings.rows.get(DRIVE)!;
      binding['requestedAt'] = new Date(Date.now() - ATTESTATION_REQUEST_MIN_INTERVAL_MS - 1_000);
      bindings.rows.set(DRIVE, binding);

      await service.resolveDrivenUnit(DRIVE, TENANT);
      expect(published).toHaveLength(2);
    });
  });

  describe('an equipment the owner does not have', () => {
    it('records unknown_equipment and refuses to actuate', async () => {
      await service.bind(DRIVE, TENANT, FEEDER);
      await service.applyAttestation({
        vfdDeviceId: DRIVE,
        tenantId: TENANT,
        drivenEquipmentId: FEEDER,
        outcome: 'unknown_equipment',
        servedUnits: [],
        attestedAt: new Date(),
      });

      const resolution = await service.resolveDrivenUnit(DRIVE, TENANT);

      expect(resolution).toMatchObject({
        kind: 'unattested',
        state: VfdDriveBindingState.UNKNOWN_EQUIPMENT,
      });
      await expect(service.assertActuable(DRIVE, TENANT)).rejects.toThrow(BadRequestException);
    });
  });
});
