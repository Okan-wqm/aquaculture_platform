import { ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { Sensor, SensorType } from '../../../database/entities/sensor.entity';
import { ConnectionTesterService } from '../../../protocol/services/connection-tester.service';
import { ProtocolRegistryService } from '../../../protocol/services/protocol-registry.service';
import { ProtocolValidatorService } from '../../../protocol/services/protocol-validator.service';
import { ChannelManagementService } from '../channel-management.service';
import { SensorRegistrationService } from '../sensor-registration.service';
import {
  generateSerialNumber,
  resolveSerialNumber,
  throwIfSerialNumberConflict,
  SENSOR_SERIAL_UNIQUE_INDEX,
} from '../serial-number.policy';

/**
 * SENSOR-MEDIUM-072: serial_number is NOT NULL + UNIQUE, but the registration DTO
 * marks serialNumber optional. The policy guarantees the column is never nulled and
 * a duplicate is a domain conflict — not a raw driver message.
 */
describe('serial-number.policy (SENSOR-MEDIUM-072)', () => {
  describe('generateSerialNumber', () => {
    it('prefixes by kind and is collision-free across calls', () => {
      const a = generateSerialNumber('SENSOR');
      const b = generateSerialNumber('SENSOR');
      expect(a).toMatch(/^SENSOR-/);
      expect(b).toMatch(/^SENSOR-/);
      expect(a).not.toBe(b);
      expect(generateSerialNumber('PARENT')).toMatch(/^PARENT-/);
    });
  });

  describe('resolveSerialNumber', () => {
    it('generates a non-empty placeholder when none is provided', () => {
      const resolved = resolveSerialNumber(undefined, 'SENSOR');
      expect(resolved).toMatch(/^SENSOR-/);
      expect(resolved.length).toBeGreaterThan('SENSOR-'.length);
    });

    it('generates when the provided value is blank/whitespace', () => {
      expect(resolveSerialNumber('   ', 'SENSOR')).toMatch(/^SENSOR-/);
    });

    it('honours (trimmed) an operator-provided value', () => {
      expect(resolveSerialNumber('  ABC-123 ', 'SENSOR')).toBe('ABC-123');
    });
  });

  describe('throwIfSerialNumberConflict', () => {
    it('maps a unique-violation on the serial index to a ConflictException naming the serial', () => {
      expect(() =>
        throwIfSerialNumberConflict(
          { code: '23505', constraint: SENSOR_SERIAL_UNIQUE_INDEX },
          'DUP-1',
        ),
      ).toThrow(ConflictException);
      try {
        throwIfSerialNumberConflict(
          { code: '23505', constraint: SENSOR_SERIAL_UNIQUE_INDEX },
          'DUP-1',
        );
      } catch (e) {
        expect((e as ConflictException).message).toContain('DUP-1');
      }
    });

    it('is a no-op for a unique-violation on a DIFFERENT constraint (e.g. channelKey)', () => {
      expect(() =>
        throwIfSerialNumberConflict({ code: '23505', constraint: 'IDX_channels_key' }, 'X'),
      ).not.toThrow();
    });

    it('is a no-op for any non-unique error', () => {
      expect(() => throwIfSerialNumberConflict({ code: '23502' }, 'X')).not.toThrow();
      expect(() => throwIfSerialNumberConflict(new Error('boom'), 'X')).not.toThrow();
    });
  });
});

describe('SensorRegistrationService serial-number handling (SENSOR-MEDIUM-072)', () => {
  const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  let service: SensorRegistrationService;
  let capturedSerial: string | undefined;
  let saveBehaviour: (obj: { serialNumber?: string }) => Promise<Record<string, unknown>>;

  const baseInput = {
    name: 'Pond Probe',
    type: SensorType.TEMPERATURE,
    protocolCode: 'mqtt',
    protocolConfiguration: { topic: 'sensors/x' },
    skipConnectionTest: true,
  };

  beforeEach(async () => {
    capturedSerial = undefined;
    saveBehaviour = (obj) => Promise.resolve({ ...obj, id: 'sensor-1', tenantId: TENANT });

    const manager = {
      save: jest.fn((_entity: unknown, obj: { serialNumber?: string }) => {
        capturedSerial = obj.serialNumber;
        return saveBehaviour(obj);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorRegistrationService,
        {
          provide: getRepositoryToken(Sensor),
          useValue: { create: (o: unknown) => o, count: jest.fn().mockResolvedValue(0) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) => cb(manager)),
          },
        },
        {
          provide: ProtocolRegistryService,
          useValue: {
            hasProtocol: () => true,
            getProtocolDetails: () => Promise.resolve({ id: 'proto-1' }),
          },
        },
        { provide: ProtocolValidatorService, useValue: { validate: () => ({ isValid: true, errors: [] }) } },
        { provide: ConnectionTesterService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: ChannelManagementService, useValue: { createChannelsForSensor: jest.fn() } },
        { provide: OutboxPublisher, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();

    service = module.get(SensorRegistrationService);
  });

  it('persists a generated serial when the operator omits it (never nulls the NOT NULL column)', async () => {
    const result = await service.registerSensor(baseInput, TENANT, 'user-1');

    expect(result.success).toBe(true);
    expect(capturedSerial).toMatch(/^SENSOR-/);
  });

  it('persists the operator-provided serial verbatim when present', async () => {
    await service.registerSensor({ ...baseInput, serialNumber: 'REAL-SN-9000' }, TENANT, 'user-1');

    expect(capturedSerial).toBe('REAL-SN-9000');
  });

  it('maps a duplicate-serial unique violation to a ConflictException (no raw driver text)', async () => {
    saveBehaviour = () =>
      Promise.reject(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: SENSOR_SERIAL_UNIQUE_INDEX,
        }),
      );

    await expect(
      service.registerSensor({ ...baseInput, serialNumber: 'DUP-1' }, TENANT, 'user-1'),
    ).rejects.toThrow(ConflictException);
  });
});
