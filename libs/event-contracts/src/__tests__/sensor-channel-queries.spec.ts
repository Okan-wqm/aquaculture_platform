import {
  isDescribeSensorChannelsRequest,
  isDescribeSensorChannelsResponse,
  MAX_DESCRIBED_CHANNELS,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
  type SensorChannelDescription,
} from '../sensor-channel-queries';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SENSOR = '22222222-2222-4222-8222-222222222222';

const found: SensorChannelDescription = {
  sensorId: SENSOR,
  channelKey: 'ammonia',
  presence: 'FOUND',
  sensorActive: true,
  siteId: null,
  systemId: null,
  tankId: null,
  channelId: '33333333-3333-4333-8333-333333333333',
  enabled: true,
  quantity: 'tan',
  quantityFamily: 'ammonia',
  unit: 'mg/L',
  calibrationDueAt: null,
  latestValue: 0.44,
  latestAt: '2026-10-07T12:00:00.000Z',
  latestQualityCode: 192,
};

describe('sensor channel description contract', () => {
  it('names a request subject under the sensor service', () => {
    expect(SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE).toBe('request.sensor.describeChannels');
  });

  it('accepts exactly the request shape, within the key cap', () => {
    const channels = [{ sensorId: SENSOR, channelKey: 'ammonia' }];
    expect(isDescribeSensorChannelsRequest({ tenantId: TENANT, channels })).toBe(true);
    expect(isDescribeSensorChannelsRequest({ tenantId: TENANT, channels, extra: 1 })).toBe(false);
    expect(
      isDescribeSensorChannelsRequest({
        tenantId: TENANT,
        channels: [{ sensorId: SENSOR, channelKey: 'ph', channelId: 'x' }],
      }),
    ).toBe(false);
    expect(
      isDescribeSensorChannelsRequest({
        tenantId: TENANT,
        channels: Array(MAX_DESCRIBED_CHANNELS + 1).fill(channels[0]),
      }),
    ).toBe(false);
  });

  it('accepts a reply with every documented field, and tolerates fields it does not know', () => {
    expect(isDescribeSensorChannelsResponse({ channels: [found] })).toBe(true);
    expect(isDescribeSensorChannelsResponse({ channels: [{ ...found, addedLater: 1 }] })).toBe(
      true,
    );
  });

  it('refuses a reply missing a field, with a wrong type, or an unknown presence', () => {
    const { latestAt: _dropped, ...missing } = found;
    expect(isDescribeSensorChannelsResponse({ channels: [missing] })).toBe(false);
    expect(isDescribeSensorChannelsResponse({ channels: [{ ...found, latestValue: '0.4' }] })).toBe(
      false,
    );
    expect(isDescribeSensorChannelsResponse({ channels: [{ ...found, presence: 'MAYBE' }] })).toBe(
      false,
    );
    expect(isDescribeSensorChannelsResponse({ channels: 'none' })).toBe(false);
  });
});
