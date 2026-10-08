import {
  CircuitBreakerService,
  DEFAULT_BREAKER_OPTIONS,
} from '@aquaculture/backend-common/resilience';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { NatsRequestReply } from '@platform/event-bus';
import {
  describesRequest,
  type DescribeSensorChannelsRequest,
  isDescribeSensorChannelsResponse,
  MAX_DESCRIBED_CHANNELS,
  SENSOR_CHANNEL_QUERY_SUBJECTS,
  type SensorChannelDescription,
  type SensorChannelKey,
} from '@platform/event-contracts';

const DESCRIBE_TIMEOUT_MS = 3_000;
const BREAKER = 'farm-sensor-channel-directory';

/**
 * What a sensor channel is now, as the sensor service answers it — the ONLY
 * farm caller of `request.sensor.describeChannels`.
 *
 * Farm binds water-chemistry parameters to channels by their natural key and
 * copies nothing about a channel into its rows, so every decision about a
 * bound channel (does it exist, is it enabled, where does its sensor stand,
 * what quantity in which unit, its last value) asks here.
 *
 * - Fail closed: a transport failure, an open breaker, a remote error or a
 *   reply that is not the contract's shape, or that does not describe exactly
 *   the asked keys in order, is a 503. A bind must not be decided on a guess,
 *   and a source's status must not be shown from one.
 * - Requests are chunked at the contract's maximum and sent one after
 *   another; the answers keep the asked order.
 * - No cache: a channel can be disabled or re-declared at any moment, and the
 *   bind re-checks inside its transaction on what this returned.
 */
@Injectable()
export class SensorChannelDirectory {
  private readonly logger = new Logger(SensorChannelDirectory.name);

  constructor(
    private readonly requestReply: NatsRequestReply,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /** One description per key, in the keys' order. */
  async describe(
    tenantId: string,
    keys: readonly SensorChannelKey[],
  ): Promise<SensorChannelDescription[]> {
    const described: SensorChannelDescription[] = [];
    for (let start = 0; start < keys.length; start += MAX_DESCRIBED_CHANNELS) {
      const request: DescribeSensorChannelsRequest = {
        tenantId,
        channels: keys
          .slice(start, start + MAX_DESCRIBED_CHANNELS)
          .map(({ sensorId, channelKey }) => ({ sensorId, channelKey })),
      };
      described.push(...(await this.describeChunk(request)));
    }
    return described;
  }

  /** One channel's description. */
  async describeOne(tenantId: string, key: SensorChannelKey): Promise<SensorChannelDescription> {
    const [description] = await this.describe(tenantId, [key]);
    if (description === undefined) {
      // describesRequest proved one answer per key; an empty answer is malformed.
      throw this.unavailable('malformed_response', { tenantId, channels: [key] });
    }
    return description;
  }

  private async describeChunk(
    request: DescribeSensorChannelsRequest,
  ): Promise<SensorChannelDescription[]> {
    let reply: unknown;
    try {
      reply = await this.circuitBreaker.execute<unknown>({
        serviceName: BREAKER,
        tenantId: request.tenantId,
        options: { ...DEFAULT_BREAKER_OPTIONS, failureMode: 'fail-closed' },
        fn: () =>
          this.requestReply.requestTyped<DescribeSensorChannelsRequest, unknown>(
            SENSOR_CHANNEL_QUERY_SUBJECTS.DESCRIBE,
            request,
            { timeoutMs: DESCRIBE_TIMEOUT_MS },
          ),
      });
    } catch (error) {
      throw this.unavailable('request_failed', request, error);
    }
    if (!isDescribeSensorChannelsResponse(reply) || !describesRequest(request, reply)) {
      throw this.unavailable('malformed_response', request);
    }
    return reply.channels;
  }

  private unavailable(
    reason: string,
    request: DescribeSensorChannelsRequest,
    error?: unknown,
  ): ServiceUnavailableException {
    this.logger.warn(
      JSON.stringify({
        event: 'sensor_channel_directory_unavailable',
        reason,
        tenantId: request.tenantId,
        channels: request.channels.length,
        errorType: error instanceof Error ? error.name : undefined,
      }),
    );
    return new ServiceUnavailableException('The sensor service cannot describe channels right now');
  }
}
