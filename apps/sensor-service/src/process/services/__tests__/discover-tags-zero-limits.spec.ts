import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UnifiedTag } from '../../entities/unified-tag.entity';
import { DeviceIoConfig } from '../../../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../../../edge-device/entities/edge-device.entity';
import { Process } from '../../entities/process.entity';
import { UnifiedTagService } from '../unified-tag.service';

/**
 * SENSOR-MEDIUM-019 — discoverTags must preserve zero-valued eng/alarm limits.
 * SENSOR-MEDIUM-021 — discoverTags must be concurrent-safe (ON CONFLICT DO NOTHING).
 *
 * A truthiness guard dropped legitimate zeros (a 0-100% level sensor's engMin=0,
 * or a low-low alarm at 0), so the discovered tag lost limits the edge should
 * enforce. Discovery also inserts new tags via an orIgnore INSERT so a
 * concurrent discovery of the same device does not 23505-roll back the batch.
 */

const TENANT = 'tenant-uuid-1';

/** A capturing INSERT query builder: records the values passed to .values(). */
function makeInsertQb(): { qb: Record<string, jest.Mock>; captured: { rows: UnifiedTag[] } } {
  const captured: { rows: UnifiedTag[] } = { rows: [] };
  const qb: Record<string, jest.Mock> = {
    insert: jest.fn(() => qb),
    into: jest.fn(() => qb),
    values: jest.fn((rows: UnifiedTag[]) => {
      captured.rows = rows;
      return qb;
    }),
    orIgnore: jest.fn(() => qb),
    execute: jest.fn().mockResolvedValue({ identifiers: [] }),
  };
  return { qb, captured };
}

describe('discoverTags (SENSOR-MEDIUM-019 / 021)', () => {
  let service: UnifiedTagService;
  let tagRepo: { find: jest.Mock; create: jest.Mock; createQueryBuilder: jest.Mock };
  let ioRepo: { find: jest.Mock };
  let deviceRepo: { findOne: jest.Mock };
  let insertCapture: { rows: UnifiedTag[] };

  beforeEach(async () => {
    const { qb, captured } = makeInsertQb();
    insertCapture = captured;
    tagRepo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((x) => x),
      createQueryBuilder: jest.fn(() => qb),
    };
    ioRepo = { find: jest.fn() };
    deviceRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UnifiedTagService,
        { provide: getRepositoryToken(UnifiedTag), useValue: tagRepo },
        { provide: getRepositoryToken(DeviceIoConfig), useValue: ioRepo },
        { provide: getRepositoryToken(EdgeDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(Process), useValue: { findOne: jest.fn() } },
      ],
    }).compile();

    service = module.get(UnifiedTagService);
  });

  it('keeps engMin=0 and alarmL=0 instead of dropping them to undefined', async () => {
    deviceRepo.findOne.mockResolvedValue({ id: 'dev-1', tenantId: TENANT, deviceCode: 'EDGE-AABB1122' });
    ioRepo.find.mockResolvedValue([
      {
        id: 'io-1',
        tagName: 'tank1.level',
        ioType: 'analog_input',
        dataType: 'float',
        engUnit: '%',
        engMin: 0,
        engMax: 100,
        alarmLL: 0,
        alarmL: 0,
        alarmH: 90,
        deadband: 0,
      },
    ]);
    // existing find -> [] (nothing yet); re-read find -> the inserted row.
    tagRepo.find
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => insertCapture.rows);

    const result = await service.discoverTags('dev-1', TENANT);

    expect(result.createdCount).toBe(1);
    const created = insertCapture.rows[0]!;
    expect(created.engMin).toBe(0);
    expect(created.engMax).toBe(100);
    expect(created.alarmLL).toBe(0);
    expect(created.alarmL).toBe(0);
    expect(created.deadband).toBe(0);
  });

  it('still maps a missing (null) limit to undefined', async () => {
    deviceRepo.findOne.mockResolvedValue({ id: 'dev-1', tenantId: TENANT, deviceCode: 'EDGE-AABB1122' });
    ioRepo.find.mockResolvedValue([
      {
        id: 'io-2',
        tagName: 'tank1.temp',
        ioType: 'analog_input',
        dataType: 'float',
        engUnit: 'C',
        engMin: null,
        alarmL: undefined,
      },
    ]);
    tagRepo.find.mockResolvedValueOnce([]).mockImplementationOnce(async () => insertCapture.rows);

    await service.discoverTags('dev-1', TENANT);

    const created = insertCapture.rows[0]!;
    expect(created.engMin).toBeUndefined();
    expect(created.alarmL).toBeUndefined();
  });

  it('inserts new tags with orIgnore so a concurrent discovery is idempotent (SENSOR-MEDIUM-021)', async () => {
    deviceRepo.findOne.mockResolvedValue({ id: 'dev-1', tenantId: TENANT, deviceCode: 'EDGE-AABB1122' });
    ioRepo.find.mockResolvedValue([
      { id: 'io-1', tagName: 'a', ioType: 'analog_input', dataType: 'float' },
      { id: 'io-2', tagName: 'b', ioType: 'analog_input', dataType: 'float' },
    ]);
    // 'a' already exists (created by a concurrent discovery); only 'b' is new.
    const existingA = { fqn: 'EDGE-AABB1122/a' } as UnifiedTag;
    tagRepo.find
      .mockResolvedValueOnce([existingA]) // existing lookup
      .mockImplementationOnce(async () => [existingA, ...insertCapture.rows]); // re-read

    const qb = tagRepo.createQueryBuilder();
    const result = await service.discoverTags('dev-1', TENANT);

    expect(qb.orIgnore).toHaveBeenCalled(); // ON CONFLICT DO NOTHING
    expect(insertCapture.rows).toHaveLength(1); // only the genuinely-new 'b'
    expect(insertCapture.rows[0]!.fqn).toBe('EDGE-AABB1122/b');
    expect(result.createdCount).toBe(1);
    expect(result.tags).toHaveLength(2);
  });
});
