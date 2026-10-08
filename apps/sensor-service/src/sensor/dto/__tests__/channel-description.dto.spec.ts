import { toDescriptionType } from '../channel-description.dto';

describe('toDescriptionType', () => {
  it('turns the wire’s ISO dates into Date scalars and keeps nulls', () => {
    const mapped = toDescriptionType({
      sensorId: 's',
      channelKey: 'ph',
      presence: 'FOUND',
      sensorActive: true,
      siteId: null,
      systemId: null,
      tankId: null,
      equipmentId: null,
      channelId: 'c',
      enabled: true,
      quantity: 'ph',
      quantityFamily: null,
      unit: 'pH',
      calibrationDueAt: null,
      configuredAt: '2026-10-07T09:00:00.000Z',
      latestValue: 7.9,
      latestAt: '2026-10-07T12:00:00.000Z',
      latestQuality: 'GOOD',
    });
    expect(mapped.configuredAt).toEqual(new Date('2026-10-07T09:00:00.000Z'));
    expect(mapped.latestAt).toEqual(new Date('2026-10-07T12:00:00.000Z'));
    expect(mapped.calibrationDueAt).toBeNull();
    expect(mapped.latestValue).toBe(7.9);
  });
});
