import { BadRequestException } from '@nestjs/common';
import { stub } from '@aquaculture/testing';
import type { DataSource } from 'typeorm';

import { ChannelDescriptionService } from '../channel-description.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SENSOR = '22222222-2222-4222-8222-222222222222';

describe('ChannelDescriptionService (no database)', () => {
  const service = new ChannelDescriptionService(stub<DataSource>({}));

  it('refuses more keys than the contract allows, before any read', async () => {
    const keys = Array.from({ length: 101 }, () => ({ sensorId: SENSOR, channelKey: 'ph' }));
    await expect(service.describe(TENANT, keys)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('answers keys without a uuid sensor id without a read', async () => {
    const [entry] = await service.describe(TENANT, [{ sensorId: 'abc', channelKey: 'ph' }]);
    expect(entry).toMatchObject({ presence: 'NO_SENSOR', channelId: null, latestValue: null });
  });
});
