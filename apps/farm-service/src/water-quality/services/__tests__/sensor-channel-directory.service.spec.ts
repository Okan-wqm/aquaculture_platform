import type { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { collaborator, stubMember } from '@aquaculture/testing';
import type { NatsRequestReply } from '@platform/event-bus';
import {
  type DescribeSensorChannelsRequest,
  MAX_DESCRIBED_CHANNELS,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
  type SensorChannelDescription,
  type SensorChannelKey,
} from '@platform/event-contracts';

import { SensorChannelDirectory } from '../sensor-channel-directory.service';

/**
 * The only farm caller of request.sensor.describeChannels must never let a
 * bind be decided on a guess: anything but the contract's exact answer is a
 * 503, and the contract's request limit is respected.
 */
/** What the UI receives when the sensor service cannot answer: a coded 503. */
const UNAVAILABLE = { code: 'SENSOR_DIRECTORY_UNAVAILABLE', status: 503 };

describe('SensorChannelDirectory', () => {
  const TENANT = 'b0b0b0b0-b0b0-4b0b-8b0b-b0b0b0b0b0b0';

  const describe_ = (key: SensorChannelKey): SensorChannelDescription => ({
    ...key,
    presence: 'FOUND',
    sensorActive: true,
    siteId: null,
    systemId: null,
    tankId: null,
    equipmentId: null,
    channelId: null,
    enabled: true,
    quantity: 'ph',
    quantityFamily: null,
    unit: 'pH',
    calibrationDueAt: null,
    configuredAt: null,
    latestValue: 7.1,
    latestAt: '2026-10-08T10:00:00Z',
    latestQuality: 'GOOD',
  });

  function directory(answer: (request: DescribeSensorChannelsRequest) => Promise<unknown>): {
    directory: SensorChannelDirectory;
    requests: DescribeSensorChannelsRequest[];
    breakerModes: string[];
  } {
    const requests: DescribeSensorChannelsRequest[] = [];
    const breakerModes: string[] = [];
    const requestReply = collaborator<NatsRequestReply>(
      {
        requestTyped: stubMember<NatsRequestReply['requestTyped']>(
          async (subject: string, request: DescribeSensorChannelsRequest) => {
            expect(subject).toBe(SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE);
            requests.push(request);
            return answer(request);
          },
        ),
      },
      'NatsRequestReply',
    );
    const circuitBreaker = collaborator<CircuitBreakerService>(
      {
        execute: stubMember<CircuitBreakerService['execute']>(
          async (args: Parameters<CircuitBreakerService['execute']>[0]) => {
            breakerModes.push(args.options.failureMode);
            return args.fn();
          },
        ),
      },
      'CircuitBreakerService',
    );
    return {
      directory: new SensorChannelDirectory(requestReply, circuitBreaker),
      requests,
      breakerModes,
    };
  }

  const keys = (count: number): SensorChannelKey[] =>
    Array.from({ length: count }, (_, index) => ({ sensorId: `s-${index}`, channelKey: 'ph' }));

  it('chunks at the contract maximum and answers in the asked order, through a fail-closed breaker', async () => {
    const {
      directory: subject,
      requests,
      breakerModes,
    } = directory(async (request) => ({
      channels: request.channels.map(describe_),
    }));
    const asked = keys(MAX_DESCRIBED_CHANNELS + 1);
    const answered = await subject.describe(TENANT, asked);
    expect(requests.map((request) => request.channels.length)).toEqual([MAX_DESCRIBED_CHANNELS, 1]);
    expect(requests.every((request) => request.tenantId === TENANT)).toBe(true);
    expect(answered.map((description) => description.sensorId)).toEqual(
      asked.map((key) => key.sensorId),
    );
    expect(breakerModes).toEqual(['fail-closed', 'fail-closed']);
  });

  it('asks nothing for no keys', async () => {
    const { directory: subject, requests } = directory(async () => ({ channels: [] }));
    await expect(subject.describe(TENANT, [])).resolves.toEqual([]);
    expect(requests).toEqual([]);
  });

  it('fails closed when the sensor service cannot be reached', async () => {
    const { directory: subject } = directory(async () => {
      throw new Error('no responders');
    });
    await expect(
      subject.describeOne(TENANT, { sensorId: 's-0', channelKey: 'ph' }),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it('fails closed on a reply that is not the contract shape or not about the asked keys', async () => {
    const malformed = directory(async (request) => ({
      channels: request.channels.map((key) => ({ ...describe_(key), unit: 7 })),
    }));
    await expect(malformed.directory.describe(TENANT, keys(1))).rejects.toMatchObject(UNAVAILABLE);
    const otherKeys = directory(async (request) => ({
      channels: request.channels.map((key) => describe_({ ...key, channelKey: 'do' })),
    }));
    await expect(otherKeys.directory.describe(TENANT, keys(2))).rejects.toMatchObject(UNAVAILABLE);
  });
});
