/**
 * CalibrationResolver (SENSOR-HIGH-083) — pins that the authenticated actor is
 * threaded into the calibration event (sub → userId) and that the mutation
 * returns the updated channel so the client sees the fresh status.
 */
import { Test } from '@nestjs/testing';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { CalibrationRecordingService } from '../calibration-recording.service';
import { CalibrationResolver } from '../calibration.resolver';

async function setup() {
  const service = {
    recordCalibration: jest.fn(),
    getCalibrationHistory: jest.fn(),
  };
  const module = await Test.createTestingModule({
    providers: [
      CalibrationResolver,
      { provide: CalibrationRecordingService, useValue: service },
    ],
  }).compile();
  return { resolver: module.get(CalibrationResolver), service };
}

function channelStub(props: Partial<SensorDataChannel>): SensorDataChannel {
  const channel = new SensorDataChannel();
  Object.assign(channel, props);
  return channel;
}

describe('CalibrationResolver (SENSOR-HIGH-083)', () => {
  it('threads the JWT subject + email into recordCalibration and returns the updated channel', async () => {
    const { resolver, service } = await setup();
    const channel = channelStub({ id: 'ch-1', lastCalibratedAt: new Date() });
    service.recordCalibration.mockResolvedValue(channel);

    const input = {
      channelId: 'ch-1',
      calibrationEnabled: true,
      calibrationMultiplier: 1.1,
      calibrationOffset: 0,
    };
    const result = await resolver.recordCalibration(input, 'tenant-1', {
      sub: 'user-42',
      email: 'op@example.com',
    });

    expect(result).toBe(channel);
    expect(service.recordCalibration).toHaveBeenCalledWith(
      'tenant-1',
      { userId: 'user-42', email: 'op@example.com' },
      input,
    );
  });

  it('falls back to a sentinel actor when no subject is present', async () => {
    const { resolver, service } = await setup();
    service.recordCalibration.mockResolvedValue(channelStub({ id: 'ch-1' }));

    await resolver.recordCalibration(
      { channelId: 'ch-1', calibrationEnabled: true, calibrationMultiplier: 1, calibrationOffset: 0 },
      'tenant-1',
      {},
    );

    expect(service.recordCalibration).toHaveBeenCalledWith(
      'tenant-1',
      { userId: 'unknown-user', email: undefined },
      expect.anything(),
    );
  });

  it('delegates calibrationHistory to the service scoped by tenant + channel', async () => {
    const { resolver, service } = await setup();
    service.getCalibrationHistory.mockResolvedValue([]);

    await resolver.calibrationHistory('ch-1', 'tenant-1');

    expect(service.getCalibrationHistory).toHaveBeenCalledWith('tenant-1', 'ch-1');
  });
});
