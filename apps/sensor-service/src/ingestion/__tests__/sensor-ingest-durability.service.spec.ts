import { IAcknowledgedEventPublisher, IEvent } from '@platform/event-bus';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { createDeterministicEventId, MqttIngestDeadLetteredEvent } from '@platform/event-contracts';

import { SensorMetricInput } from '../../database/entities/sensor-metric.entity';
import {
  IngestQueryExecutor,
  ManagedMetricWriter,
  SensorIngestDurabilityService,
} from '../sensor-ingest-durability.service';

const SOURCE_EVENT_ID = 'edge:device-1:1700000000';
const TENANT_ID = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'a'.repeat(64);
const CHILD_EVENT: IEvent = {
  eventId: '11111111-1111-5111-8111-111111111111',
  eventType: 'SensorReading',
  timestamp: '2026-08-25T12:00:00.000Z',
  tenantId: TENANT_ID,
};
const METRIC: SensorMetricInput = {
  time: new Date('2026-08-25T12:00:00.000Z'),
  sensorId: '11111111-1111-4111-8111-111111111111',
  channelId: '22222222-2222-4222-8222-222222222222',
  tenantId: TENANT_ID,
  rawValue: 20,
  value: 20,
  sourceEventId: SOURCE_EVENT_ID,
  sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
};
const DEAD_LETTER_EVENT: MqttIngestDeadLetteredEvent = {
  eventId: createDeterministicEventId(SOURCE_EVENT_ID, 'dead-letter'),
  eventType: 'MqttIngestDeadLettered',
  timestamp: '2026-08-25T12:00:01.000Z',
  tenantId: TENANT_ID,
  version: 1,
  aggregateId: METRIC.sensorId,
  aggregateType: 'Sensor',
  topic: 'sensors/t/s/data',
  payloadDigest: DIGEST,
  reason: 'UNKNOWN_PROCESSING_FAILURE',
  payloadBase64: 'e30=',
  sourceEventId: SOURCE_EVENT_ID,
  sourceTimestamp: '2026-08-25T12:00:00.000Z',
  processingAttempts: 5,
  originalSubject: 'telemetry.t.SensorReading',
  originalEventJson: JSON.stringify(CHILD_EVENT),
};

function createWriter(): jest.Mocked<ManagedMetricWriter> {
  return { writeManaged: jest.fn().mockResolvedValue(undefined) };
}

function createPublisher(): jest.Mocked<IAcknowledgedEventPublisher> {
  return {
    publishToWithAck: jest.fn().mockResolvedValue({
      stream: 'AQUACULTURE_TELEMETRY',
      sequence: 91,
      duplicate: false,
    }),
  };
}

describe('SensorIngestDurabilityService', () => {
  it('records receipt, metrics, and deterministic child dispatch in one manager boundary', async () => {
    const calls: string[] = [];
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        calls.push(sql);
        if (sql.includes('INSERT INTO sensor_ingest_receipts')) {
          return Promise.resolve([{ source_event_id: SOURCE_EVENT_ID }]);
        }
        return Promise.resolve([]);
      }),
    };
    const writer = createWriter();
    writer.writeManaged.mockImplementation(() => {
      calls.push('WRITE_METRICS');
      return Promise.resolve();
    });
    const service = new SensorIngestDurabilityService(writer, createPublisher());

    await expect(
      service.recordManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        sourceSequence: '1700000000',
        metrics: [METRIC],
        dispatches: [{ subject: 'telemetry.t.SensorReading', event: CHILD_EVENT }],
      }),
    ).resolves.toBe('COMMITTED');

    expect(calls[0]).toContain("lock_timeout = '1s'");
    expect(calls[1]).toContain("statement_timeout = '5s'");
    expect(calls[2]).toContain('pg_advisory_xact_lock');
    expect(calls[3]).toContain('tenant_erasure_target_proofs');
    expect(calls[4]).toContain('INSERT INTO sensor_ingest_receipts');
    expect(calls[5]).toBe('WRITE_METRICS');
    expect(calls[6]).toContain('INSERT INTO sensor_event_dispatch');
  });

  it('treats an identical committed source identity as a no-op', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('INSERT INTO sensor_ingest_receipts')) return Promise.resolve([]);
        if (sql.includes('SELECT payload_digest')) {
          return Promise.resolve([{ payload_digest: DIGEST, commit_status: 'COMMITTED' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const writer = createWriter();
    const service = new SensorIngestDurabilityService(writer, createPublisher());

    await expect(
      service.recordManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        metrics: [METRIC],
        dispatches: [{ subject: 'telemetry.t.SensorReading', event: CHILD_EVENT }],
      }),
    ).resolves.toBe('DUPLICATE');
    expect(writer.writeManaged).not.toHaveBeenCalled();
  });

  it('fails closed when the same source identity arrives with different bytes', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('tenant_erasure_target_proofs')) return Promise.resolve([]);
        if (sql.includes('INSERT INTO sensor_ingest_receipts')) return Promise.resolve([]);
        return Promise.resolve([{ payload_digest: 'b'.repeat(64) }]);
      }),
    };
    const service = new SensorIngestDurabilityService(createWriter(), createPublisher());

    await expect(
      service.recordManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        metrics: [METRIC],
        dispatches: [{ subject: 'telemetry.t.SensorReading', event: CHILD_EVENT }],
      }),
    ).rejects.toThrow('SOURCE_EVENT_ID_COLLISION');
  });

  it('stores JetStream stream and sequence only after the child PubAck', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT child_event_id')) {
          return Promise.resolve([
            {
              child_event_id: CHILD_EVENT.eventId,
              subject: 'telemetry.t.SensorReading',
              payload: CHILD_EVENT,
            },
          ]);
        }
        return Promise.resolve([]);
      }),
    };
    const publisher = createPublisher();
    const service = new SensorIngestDurabilityService(createWriter(), publisher);

    await service.publishPendingManaged(manager, SOURCE_EVENT_ID);

    expect(publisher.publishToWithAck).toHaveBeenCalledWith(
      'telemetry.t.SensorReading',
      CHILD_EVENT,
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET dispatch_status = 'ACKED'"),
      [CHILD_EVENT.eventId, 'AQUACULTURE_TELEMETRY', 91],
    );
  });

  it('leaves dispatch pending when JetStream rejects the publish', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) =>
        sql.includes('SELECT child_event_id')
          ? Promise.resolve([
              {
                child_event_id: CHILD_EVENT.eventId,
                subject: 'telemetry.t.SensorReading',
                payload: CHILD_EVENT,
              },
            ])
          : Promise.resolve([]),
      ),
    };
    const publisher = createPublisher();
    publisher.publishToWithAck.mockRejectedValue(new Error('stream full'));
    const service = new SensorIngestDurabilityService(createWriter(), publisher);

    await expect(service.publishPendingManaged(manager, SOURCE_EVENT_ID)).rejects.toThrow(
      'stream full',
    );
    expect(manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining("SET dispatch_status = 'ACKED'"),
      expect.anything(),
    );
  });

  it('serializes writes behind the tenant-erasure fence and ACK-drops an erased tenant', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('tenant_erasure_target_proofs')) {
          return Promise.resolve([{ erased: true }]);
        }
        return Promise.resolve([]);
      }),
    };
    const writer = createWriter();
    const service = new SensorIngestDurabilityService(writer, createPublisher());

    await expect(
      service.recordManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        metrics: [METRIC],
        dispatches: [{ subject: 'telemetry.t.SensorReading', event: CHILD_EVENT }],
      }),
    ).rejects.toBeInstanceOf(TenantErasureTombstoneError);

    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [
      expect.stringContaining('tenant-erasure-fence-v1'),
    ]);
    expect(manager.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO sensor_ingest_receipts'),
      expect.anything(),
    );
    expect(writer.writeManaged).not.toHaveBeenCalled();
  });

  it('persists unknown processing attempts and returns the real fifth attempt', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('RETURNING processing_attempts')) {
          return Promise.resolve([{ processing_attempts: 5 }]);
        }
        return Promise.resolve([]);
      }),
    };
    const service = new SensorIngestDurabilityService(createWriter(), createPublisher());

    await expect(
      service.recordUnknownFailureManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        errorMessage: 'calibration failed',
      }),
    ).resolves.toBe(5);
  });

  it('resumes a retrying receipt and commits metrics without changing source identity', async () => {
    const manager: IngestQueryExecutor = {
      query: jest.fn().mockImplementation((sql: string) => {
        if (sql.includes('tenant_erasure_target_proofs')) return Promise.resolve([]);
        if (sql.includes('INSERT INTO sensor_ingest_receipts')) return Promise.resolve([]);
        if (sql.includes('SELECT payload_digest')) {
          return Promise.resolve([{ payload_digest: DIGEST, commit_status: 'RETRYING' }]);
        }
        return Promise.resolve([]);
      }),
    };
    const writer = createWriter();
    const service = new SensorIngestDurabilityService(writer, createPublisher());

    await expect(
      service.recordManaged(manager, {
        tenantId: TENANT_ID,
        sourceEventId: SOURCE_EVENT_ID,
        payloadDigest: DIGEST,
        topic: 'sensors/t/s/data',
        sourceTimestamp: new Date('2026-08-25T12:00:00.000Z'),
        metrics: [METRIC],
        dispatches: [{ subject: 'telemetry.t.SensorReading', event: CHILD_EVENT }],
      }),
    ).resolves.toBe('COMMITTED');

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET commit_status = 'COMMITTED'"),
      [SOURCE_EVENT_ID],
    );
    expect(writer.writeManaged).toHaveBeenCalledWith([METRIC], manager);
  });

  it('publishes a deterministic DLQ event before marking the receipt dead-lettered', async () => {
    const manager: IngestQueryExecutor = { query: jest.fn().mockResolvedValue([]) };
    const publisher = createPublisher();
    const service = new SensorIngestDurabilityService(createWriter(), publisher);
    const deadLetterEvent: IEvent = {
      ...CHILD_EVENT,
      eventId: '22222222-2222-5222-8222-222222222222',
      eventType: 'MqttIngestDeadLettered',
    };

    await service.publishDeadLetterManaged(manager, SOURCE_EVENT_ID, deadLetterEvent);

    expect(publisher.publishToWithAck).toHaveBeenCalledWith('dlq.mqtt', deadLetterEvent);
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET commit_status = 'DLQ'"),
      [SOURCE_EVENT_ID],
    );
    expect(publisher.publishToWithAck.mock.invocationCallOrder[0]).toBeLessThan(
      (manager.query as jest.Mock).mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('replays the original stable event and ACKs the DLQ message only after PubAck', async () => {
    const publisher = createPublisher();
    const service = new SensorIngestDurabilityService(createWriter(), publisher);
    const acknowledgeDlq = jest.fn().mockResolvedValue(undefined);

    await service.replayDeadLetter(DEAD_LETTER_EVENT, acknowledgeDlq);

    expect(publisher.publishToWithAck).toHaveBeenCalledWith(
      DEAD_LETTER_EVENT.originalSubject,
      CHILD_EVENT,
    );
    expect(publisher.publishToWithAck.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeDlq.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it('does not ACK the DLQ message when replay PubAck is rejected', async () => {
    const publisher = createPublisher();
    publisher.publishToWithAck.mockRejectedValue(new Error('telemetry stream full'));
    const service = new SensorIngestDurabilityService(createWriter(), publisher);
    const acknowledgeDlq = jest.fn().mockResolvedValue(undefined);

    await expect(service.replayDeadLetter(DEAD_LETTER_EVENT, acknowledgeDlq)).rejects.toThrow(
      'telemetry stream full',
    );
    expect(acknowledgeDlq).not.toHaveBeenCalled();
  });
});
