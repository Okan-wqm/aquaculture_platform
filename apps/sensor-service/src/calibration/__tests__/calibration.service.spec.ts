/**
 * CalibrationRecordingService (SENSOR-HIGH-083).
 *
 * These specs pin the behaviour that makes calibration status truthful:
 * recordCalibration MUST stamp lastCalibratedAt (so a calibrated channel stops
 * reading "never calibrated") and MUST compute nextCalibrationDue from a
 * per-channel interval (so overdue warnings can fire), all in one transaction
 * that also appends an immutable CalibrationEvent carrying the actor.
 */
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  SensorDataChannel,
  ChannelDataType,
} from '../../database/entities/sensor-data-channel.entity';
import { CalibrationEvent } from '../calibration-event.entity';
import { CalibrationRecordingService } from '../calibration-recording.service';

const TENANT = 'tenant-1';
const ACTOR = { userId: 'user-9', email: 'op@example.com' };

function buildChannel(overrides: Partial<SensorDataChannel> = {}): SensorDataChannel {
  const channel = new SensorDataChannel();
  Object.assign(channel, {
    id: 'ch-1',
    sensorId: 'sensor-1',
    tenantId: TENANT,
    channelKey: 'water_temp',
    dataType: ChannelDataType.NUMBER,
    calibrationEnabled: false,
    calibrationMultiplier: 1,
    calibrationOffset: 0,
    ...overrides,
  });
  return channel;
}

interface Harness {
  service: CalibrationRecordingService;
  eventFind: jest.Mock;
  managerSave: jest.Mock;
  savedEvent: () => Partial<CalibrationEvent>;
}

async function setup(channel: SensorDataChannel | null): Promise<Harness> {
  const channelFindOne = jest.fn().mockResolvedValue(channel);
  const eventFind = jest.fn();

  let createdEvent: Partial<CalibrationEvent> = {};
  const managerCreate = jest.fn((entity: unknown, plain: Partial<CalibrationEvent>) => {
    if (entity === CalibrationEvent) {
      createdEvent = plain;
    }
    return plain;
  });
  const managerSave = jest.fn((_entity: unknown, obj: unknown) => Promise.resolve(obj));
  const manager = { create: managerCreate, save: managerSave };
  const dataSource = {
    transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) => cb(manager)),
  };

  const module = await Test.createTestingModule({
    providers: [
      CalibrationRecordingService,
      { provide: getRepositoryToken(CalibrationEvent), useValue: { find: eventFind } },
      { provide: getRepositoryToken(SensorDataChannel), useValue: { findOne: channelFindOne } },
      { provide: DataSource, useValue: dataSource },
    ],
  }).compile();

  return {
    service: module.get(CalibrationRecordingService),
    eventFind,
    managerSave,
    savedEvent: () => createdEvent,
  };
}

describe('CalibrationRecordingService.recordCalibration (SENSOR-HIGH-083)', () => {
  it('stamps lastCalibratedAt and computes nextCalibrationDue from the given interval', async () => {
    const h = await setup(buildChannel());

    const before = Date.now();
    const result = await h.service.recordCalibration(TENANT, ACTOR, {
      channelId: 'ch-1',
      calibrationEnabled: true,
      calibrationMultiplier: 1.05,
      calibrationOffset: -0.2,
      intervalDays: 30,
    });
    const after = Date.now();

    // Channel is stamped — this is the whole point: status can no longer read "never".
    expect(result.lastCalibratedAt).toBeInstanceOf(Date);
    const stamped = result.lastCalibratedAt!.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);

    expect(result.calibrationEnabled).toBe(true);
    expect(result.calibrationMultiplier).toBe(1.05);
    expect(result.calibrationOffset).toBe(-0.2);
    expect(result.calibrationIntervalDays).toBe(30);

    const due = result.nextCalibrationDue!.getTime();
    expect(due).toBe(stamped + 30 * 24 * 60 * 60 * 1000);

    // The immutable event captured the actor + the resulting coefficients.
    const event = h.savedEvent();
    expect(event.performedBy).toBe('user-9');
    expect(event.performedByEmail).toBe('op@example.com');
    expect(event.calibrationMultiplier).toBe(1.05);
    expect(event.channelId).toBe('ch-1');
    expect(event.sensorId).toBe('sensor-1');
    expect(h.managerSave).toHaveBeenCalledWith(CalibrationEvent, expect.anything());
  });

  it('reuses the channel stored interval when none is supplied', async () => {
    const h = await setup(buildChannel({ calibrationIntervalDays: 90 }));

    const result = await h.service.recordCalibration(TENANT, ACTOR, {
      channelId: 'ch-1',
      calibrationEnabled: true,
      calibrationMultiplier: 2,
      calibrationOffset: 0,
    });

    const stamped = result.lastCalibratedAt!.getTime();
    expect(result.nextCalibrationDue!.getTime()).toBe(stamped + 90 * 24 * 60 * 60 * 1000);
    expect(h.savedEvent().intervalDays).toBe(90);
  });

  it('leaves nextCalibrationDue unset when no interval is known (no fabricated due date)', async () => {
    const h = await setup(buildChannel());

    const result = await h.service.recordCalibration(TENANT, ACTOR, {
      channelId: 'ch-1',
      calibrationEnabled: true,
      calibrationMultiplier: 1,
      calibrationOffset: 0,
    });

    expect(result.lastCalibratedAt).toBeInstanceOf(Date);
    expect(result.nextCalibrationDue).toBeUndefined();
    expect(h.savedEvent().nextCalibrationDue).toBeUndefined();
  });

  it('persists supplied reference points on the event for provenance', async () => {
    const h = await setup(buildChannel());

    await h.service.recordCalibration(TENANT, ACTOR, {
      channelId: 'ch-1',
      calibrationEnabled: true,
      calibrationMultiplier: 1,
      calibrationOffset: 0,
      referenceValues: [
        { raw: 7.0, reference: 7.01, label: 'buffer-7' },
        { raw: 4.0, reference: 4.0 },
      ],
    });

    expect(h.savedEvent().referenceValues).toEqual([
      { raw: 7.0, reference: 7.01, label: 'buffer-7' },
      { raw: 4.0, reference: 4.0 },
    ]);
  });

  it('throws NotFound when the channel does not exist for the tenant', async () => {
    const h = await setup(null);

    await expect(
      h.service.recordCalibration(TENANT, ACTOR, {
        channelId: 'missing',
        calibrationEnabled: true,
        calibrationMultiplier: 1,
        calibrationOffset: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.managerSave).not.toHaveBeenCalled();
  });

  it('rejects calibration on a non-numeric channel', async () => {
    const h = await setup(buildChannel({ dataType: ChannelDataType.STRING }));

    await expect(
      h.service.recordCalibration(TENANT, ACTOR, {
        channelId: 'ch-1',
        calibrationEnabled: true,
        calibrationMultiplier: 1,
        calibrationOffset: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a zero multiplier (it would collapse every reading to the offset)', async () => {
    const h = await setup(buildChannel());

    await expect(
      h.service.recordCalibration(TENANT, ACTOR, {
        channelId: 'ch-1',
        calibrationEnabled: true,
        calibrationMultiplier: 0,
        calibrationOffset: 5,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.managerSave).not.toHaveBeenCalled();
  });
});

describe('CalibrationRecordingService.getCalibrationHistory', () => {
  it('queries events by tenant + channel, newest first', async () => {
    const h = await setup(buildChannel());
    h.eventFind.mockResolvedValue([{ id: 'e1' }]);

    const history = await h.service.getCalibrationHistory(TENANT, 'ch-1');

    expect(history).toEqual([{ id: 'e1' }]);
    expect(h.eventFind).toHaveBeenCalledWith({
      where: { tenantId: TENANT, channelId: 'ch-1' },
      order: { calibratedAt: 'DESC' },
    });
  });
});
