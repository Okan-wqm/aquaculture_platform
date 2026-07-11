import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { UnifiedTag } from '../../entities/unified-tag.entity';
import { DeviceIoConfig } from '../../../edge-device/entities/device-io-config.entity';
import { EdgeDevice } from '../../../edge-device/entities/edge-device.entity';
import { Process } from '../../entities/process.entity';
import { UnifiedTagService } from '../unified-tag.service';

/**
 * SENSOR-MEDIUM-019 — discoverTags must preserve zero-valued eng/alarm limits.
 *
 * A truthiness guard dropped legitimate zeros (a 0-100% level sensor's engMin=0,
 * or a low-low alarm at 0), so the discovered tag lost limits the edge should
 * enforce. The fix preserves zero via a null-check.
 */

const TENANT = 'tenant-uuid-1';

describe('discoverTags zero-value limits (SENSOR-MEDIUM-019)', () => {
  let service: UnifiedTagService;
  let tagRepo: { find: jest.Mock; create: jest.Mock; save: jest.Mock };
  let ioRepo: { find: jest.Mock };
  let deviceRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    tagRepo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation((x) => x),
      save: jest.fn().mockImplementation((x) => Promise.resolve(x)),
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

    const result = await service.discoverTags('dev-1', TENANT);

    expect(result.createdCount).toBe(1);
    const created = tagRepo.save.mock.calls[0][0][0] as UnifiedTag;
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

    await service.discoverTags('dev-1', TENANT);

    const created = tagRepo.save.mock.calls[0][0][0] as UnifiedTag;
    expect(created.engMin).toBeUndefined();
    expect(created.alarmL).toBeUndefined();
  });
});
