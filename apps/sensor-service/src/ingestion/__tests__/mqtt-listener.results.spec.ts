/**
 * A device's results topic reaches the result store (ADR-048 DEC-27): the
 * listener hands the message BYTES to EdgeResultTelemetryService (which hashes
 * and validates them against the contract) and a storage failure rejects the
 * promise the MQTT ack gate awaits, so PUBACK is never released for a result
 * that was not stored.
 */
import { collaborator } from '@aquaculture/testing';
import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';

import type { EdgeResultTelemetryService } from '../../edge-device/edge-result-telemetry.service';
import type { MqttClientService } from '../../shared-mqtt/mqtt-client.service';
import type { OutboxPublisher } from '@platform/outbox';
import type { SensorMetricWriterService } from '../sensor-metric-writer.service';
import type { SensorTopicCacheService } from '../sensor-topic-cache.service';
import { MqttListenerService, SENSOR_SERVICE_SUBSCRIPTION_FILTERS } from '../mqtt-listener.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
const TOPIC = `tenants/${TENANT}/devices/${DEVICE}/results`;

function build(ingest: jest.Mock | null): {
  deliver: (topic: string, payload: Buffer) => Promise<void>;
  failed: jest.Mock;
} {
  const failed = jest.fn();
  const service = new MqttListenerService(
    new ConfigService({}),
    collaborator<DataSource>({}, 'dataSource'),
    collaborator<SensorMetricWriterService>({}, 'metricWriter'),
    collaborator<OutboxPublisher>({}, 'outbox'),
    null,
    null,
    collaborator<SensorTopicCacheService>({}, 'topicCache'),
    collaborator<MqttClientService>(
      {
        recordMessageReceived: jest.fn(),
        recordMessageProcessed: jest.fn(),
        recordMessageFailed: failed,
      },
      'mqtt',
    ),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    ingest === null
      ? null
      : collaborator<EdgeResultTelemetryService>({ ingest }, 'EdgeResultTelemetryService'),
  );
  return { deliver: (topic, payload) => service['messageHandler'](topic, payload), failed };
}

describe('the results topic reaches the result store', () => {
  it("hands the raw bytes and the topic's tenant and device to the store", async () => {
    const ingest = jest.fn().mockResolvedValue({ status: 'stored' });
    const { deliver } = build(ingest);
    const payload = Buffer.from('{"_type":"suderra.result.v1"}');
    await deliver(TOPIC, payload);
    expect(ingest).toHaveBeenCalledTimes(1);
    const [source, bytes] = ingest.mock.calls[0] as [unknown, Buffer];
    expect(source).toEqual({ tenantId: TENANT, deviceIdentifier: DEVICE });
    expect(bytes.equals(payload)).toBe(true);
  });

  it('a storage failure rejects what the ack gate awaits, so the result is redelivered', async () => {
    const ingest = jest.fn().mockRejectedValue(new Error('database unavailable'));
    const { deliver, failed } = build(ingest);
    await expect(deliver(TOPIC, Buffer.from('{}'))).rejects.toThrow('database unavailable');
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('a refused result is settled for good: the message is acknowledged', async () => {
    const ingest = jest.fn().mockResolvedValue({ status: 'refused', reason: 'invalid' });
    const { deliver, failed } = build(ingest);
    await expect(deliver(TOPIC, Buffer.from('not json'))).resolves.toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
  });

  it('does not swallow a result that arrives where no store is configured', async () => {
    const { deliver } = build(null);
    await expect(deliver(TOPIC, Buffer.from('{}'))).resolves.toBeUndefined();
  });

  it('the listener subscribes to the per-device results filter', () => {
    expect(SENSOR_SERVICE_SUBSCRIPTION_FILTERS).toContain('tenants/+/devices/+/results');
  });
});
