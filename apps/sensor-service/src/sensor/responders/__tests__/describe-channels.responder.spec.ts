import { stub } from '@aquaculture/testing';
import type { NatsRequestReply } from '@platform/event-bus';
import { SENSOR_CHANNEL_QUERY_SUBJECTS } from '@platform/event-contracts';

import type { ChannelDescriptionService } from '../../services/channel-description.service';
import {
  DescribeChannelsResponder,
  SensorChannelAuthorityUnavailableError,
  SensorChannelRequestInvalidError,
} from '../describe-channels.responder';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SENSOR = '22222222-2222-4222-8222-222222222222';

/** The sensor answer behind farm's channel bindings, over core NATS. */
describe('DescribeChannelsResponder', () => {
  const drain = jest.fn().mockResolvedValue(undefined);
  const respond = jest
    .fn()
    .mockResolvedValue({ subject: SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE, drain });
  const describeChannels = jest.fn();
  const responder = new DescribeChannelsResponder(
    stub<NatsRequestReply>({ respond }),
    stub<ChannelDescriptionService>({ describe: describeChannels }),
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('registers and drains the shared subject in the sensor-service queue', async () => {
    await responder.onModuleInit();
    expect(respond).toHaveBeenCalledWith(
      SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE,
      expect.any(Function),
      { queue: 'sensor-service' },
    );
    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('answers with the description service, in the tenant of the request', async () => {
    describeChannels.mockResolvedValue([
      { sensorId: SENSOR, channelKey: 'ph', presence: 'NO_CHANNEL' },
    ]);
    const channels = [{ sensorId: SENSOR, channelKey: 'ph' }];
    await expect(responder.describe({ tenantId: TENANT, channels })).resolves.toEqual({
      channels: [{ sensorId: SENSOR, channelKey: 'ph', presence: 'NO_CHANNEL' }],
    });
    expect(describeChannels).toHaveBeenCalledWith(TENANT, channels);
  });

  it('refuses a request that does not match the contract, before any read', async () => {
    await expect(responder.describe({ tenantId: 'bad', channels: [] })).rejects.toBeInstanceOf(
      SensorChannelRequestInvalidError,
    );
    await expect(
      responder.describe({
        tenantId: TENANT,
        channels: Array(101).fill({ sensorId: SENSOR, channelKey: 'ph' }),
      }),
    ).rejects.toBeInstanceOf(SensorChannelRequestInvalidError);
    expect(describeChannels).not.toHaveBeenCalled();
  });

  it('reports an unavailable authority instead of an empty answer', async () => {
    describeChannels.mockRejectedValue(new Error('relation "sensors" does not exist'));
    await expect(
      responder.describe({ tenantId: TENANT, channels: [{ sensorId: SENSOR, channelKey: 'ph' }] }),
    ).rejects.toBeInstanceOf(SensorChannelAuthorityUnavailableError);
  });
});
