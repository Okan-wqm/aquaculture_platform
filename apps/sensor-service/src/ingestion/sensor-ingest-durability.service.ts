import { Inject, Injectable } from '@nestjs/common';
import {
  tenantErasureFenceLockKey,
  TenantErasureTombstoneError,
} from '@aquaculture/backend-common/compliance';
import { IAcknowledgedEventPublisher, IEvent } from '@platform/event-bus';
import { MqttIngestDeadLetteredEvent } from '@platform/event-contracts';

import { SensorMetricInput } from '../database/entities/sensor-metric.entity';
import { MetricQueryExecutor, SensorMetricWriterService } from './sensor-metric-writer.service';

export type IngestQueryExecutor = MetricQueryExecutor;

export interface ManagedMetricWriter {
  writeManaged(metrics: SensorMetricInput[], manager: MetricQueryExecutor): Promise<void>;
}

interface SensorDispatch {
  subject: string;
  event: IEvent;
}

export interface RecordIngestInput {
  tenantId: string;
  sourceEventId: string;
  payloadDigest: string;
  topic: string;
  sourceTimestamp: Date;
  sourceSequence?: string;
  metrics: SensorMetricInput[];
  dispatches: SensorDispatch[];
}

export interface RecordUnknownFailureInput {
  tenantId: string;
  sourceEventId: string;
  payloadDigest: string;
  topic: string;
  sourceTimestamp: Date;
  sourceSequence?: string;
  errorMessage: string;
}

interface PendingDispatchRow {
  childEventId: string;
  subject: string;
  payload: IEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error('Sensor ingest ledger query returned an invalid row set');
  }
  return value;
}

function requireEvent(value: unknown): IEvent {
  if (
    !isRecord(value) ||
    typeof value['eventId'] !== 'string' ||
    typeof value['eventType'] !== 'string' ||
    typeof value['timestamp'] !== 'string'
  ) {
    throw new Error('Sensor dispatch ledger contains an invalid event payload');
  }
  return {
    ...value,
    eventId: value['eventId'],
    eventType: value['eventType'],
    timestamp: value['timestamp'],
  };
}

function requireAttemptCount(rows: Record<string, unknown>[]): number {
  const attemptCount = rows[0] && rows[0]['processing_attempts'];
  const parsed = typeof attemptCount === 'number' ? attemptCount : Number(attemptCount);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('Sensor ingest receipt returned an invalid processing attempt count');
  }
  return parsed;
}

@Injectable()
export class SensorIngestDurabilityService {
  constructor(
    @Inject(SensorMetricWriterService)
    private readonly metricWriter: ManagedMetricWriter,
    @Inject('EVENT_BUS')
    private readonly publisher: IAcknowledgedEventPublisher,
  ) {}

  async recordManaged(
    manager: IngestQueryExecutor,
    input: RecordIngestInput,
  ): Promise<'COMMITTED' | 'DUPLICATE'> {
    await this.applyTransactionLimits(manager);
    await this.assertTenantNotErased(manager, input.tenantId);

    const inserted = requireRows(
      await manager.query(
        `INSERT INTO sensor_ingest_receipts (
           source_event_id, payload_digest, mqtt_topic, source_timestamp, source_sequence
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_event_id) DO NOTHING
         RETURNING source_event_id`,
        [
          input.sourceEventId,
          input.payloadDigest,
          input.topic,
          input.sourceTimestamp.toISOString(),
          input.sourceSequence ?? null,
        ],
      ),
    );

    if (inserted.length === 0) {
      const existing = requireRows(
        await manager.query(
          `SELECT payload_digest, commit_status
             FROM sensor_ingest_receipts
            WHERE source_event_id = $1
            FOR UPDATE`,
          [input.sourceEventId],
        ),
      );
      const existingReceipt = existing[0];
      if (!existingReceipt) {
        throw new Error('Sensor ingest receipt disappeared while resolving a conflict');
      }
      const digest = existingReceipt['payload_digest'];
      if (digest !== input.payloadDigest) {
        throw new Error(
          'SOURCE_EVENT_ID_COLLISION: stable identity was reused for different bytes',
        );
      }
      const status = existingReceipt['commit_status'];
      if (status === 'COMMITTED' || status === 'DLQ') {
        return 'DUPLICATE';
      }
      if (status !== 'RETRYING') {
        throw new Error('Sensor ingest receipt contains an invalid commit status');
      }
      await manager.query(
        `UPDATE sensor_ingest_receipts
            SET commit_status = 'COMMITTED',
                committed_at = now(),
                last_error = NULL
          WHERE source_event_id = $1`,
        [input.sourceEventId],
      );
    }

    await this.metricWriter.writeManaged(input.metrics, manager);
    for (const dispatch of input.dispatches) {
      await manager.query(
        `INSERT INTO sensor_event_dispatch (
           child_event_id, source_event_id, subject, payload
         ) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (child_event_id) DO NOTHING`,
        [
          dispatch.event.eventId,
          input.sourceEventId,
          dispatch.subject,
          JSON.stringify(dispatch.event),
        ],
      );
    }
    return 'COMMITTED';
  }

  async recordUnknownFailureManaged(
    manager: IngestQueryExecutor,
    input: RecordUnknownFailureInput,
  ): Promise<number> {
    await this.applyTransactionLimits(manager);
    await this.assertTenantNotErased(manager, input.tenantId);
    const rows = requireRows(
      await manager.query(
        `INSERT INTO sensor_ingest_receipts (
           source_event_id, payload_digest, mqtt_topic, source_timestamp,
           source_sequence, commit_status, processing_attempts, last_error,
           committed_at
         ) VALUES ($1, $2, $3, $4, $5, 'RETRYING', 1, $6, NULL)
         ON CONFLICT (source_event_id) DO UPDATE
           SET processing_attempts = sensor_ingest_receipts.processing_attempts + 1,
               last_error = EXCLUDED.last_error
         WHERE sensor_ingest_receipts.payload_digest = EXCLUDED.payload_digest
           AND sensor_ingest_receipts.commit_status = 'RETRYING'
         RETURNING processing_attempts`,
        [
          input.sourceEventId,
          input.payloadDigest,
          input.topic,
          input.sourceTimestamp.toISOString(),
          input.sourceSequence ?? null,
          input.errorMessage,
        ],
      ),
    );
    if (rows.length > 0) {
      return requireAttemptCount(rows);
    }
    const existing = requireRows(
      await manager.query(
        `SELECT payload_digest, commit_status, processing_attempts
           FROM sensor_ingest_receipts
          WHERE source_event_id = $1
          FOR UPDATE`,
        [input.sourceEventId],
      ),
    );
    const existingReceipt = existing[0];
    if (!existingReceipt) {
      throw new Error('Sensor ingest failure receipt disappeared while resolving a conflict');
    }
    if (existingReceipt['payload_digest'] !== input.payloadDigest) {
      throw new Error('SOURCE_EVENT_ID_COLLISION: stable identity was reused for different bytes');
    }
    throw new Error(
      `Sensor ingest failure cannot advance receipt ${String(existingReceipt['commit_status'])}`,
    );
  }

  async publishPendingManaged(manager: IngestQueryExecutor, sourceEventId: string): Promise<void> {
    await this.applyTransactionLimits(manager);
    const rows = requireRows(
      await manager.query(
        `SELECT child_event_id, subject, payload
           FROM sensor_event_dispatch
          WHERE source_event_id = $1
            AND dispatch_status = 'PENDING'
          ORDER BY created_at, child_event_id
          FOR UPDATE`,
        [sourceEventId],
      ),
    );

    const pending: PendingDispatchRow[] = rows.map((row) => {
      const childEventId = row['child_event_id'];
      const subject = row['subject'];
      if (typeof childEventId !== 'string' || typeof subject !== 'string') {
        throw new Error('Sensor dispatch ledger contains an invalid dispatch identity');
      }
      return { childEventId, subject, payload: requireEvent(row['payload']) };
    });

    for (const dispatch of pending) {
      const ack = await this.publisher.publishToWithAck(dispatch.subject, dispatch.payload);
      await manager.query(
        `UPDATE sensor_event_dispatch
            SET dispatch_status = 'ACKED',
                puback_stream = $2,
                puback_sequence = $3,
                attempt_count = attempt_count + 1,
                last_error = NULL,
                acked_at = now()
          WHERE child_event_id = $1
            AND dispatch_status = 'PENDING'`,
        [dispatch.childEventId, ack.stream, ack.sequence],
      );
    }
  }

  async publishQuarantine(event: IEvent): Promise<void> {
    await this.publisher.publishToWithAck('quarantine.mqtt', event);
  }

  async publishDeadLetterManaged(
    manager: IngestQueryExecutor,
    sourceEventId: string,
    event: IEvent,
  ): Promise<void> {
    await this.publisher.publishToWithAck('dlq.mqtt', event);
    await manager.query(
      `UPDATE sensor_ingest_receipts
          SET commit_status = 'DLQ',
              committed_at = NULL,
              dead_lettered_at = now()
        WHERE source_event_id = $1
          AND commit_status = 'RETRYING'`,
      [sourceEventId],
    );
  }

  async replayDeadLetter(
    event: MqttIngestDeadLetteredEvent,
    acknowledgeDlq: () => Promise<void>,
  ): Promise<void> {
    const originalEvent = requireEvent(JSON.parse(event.originalEventJson));
    await this.publisher.publishToWithAck(event.originalSubject, originalEvent);
    await acknowledgeDlq();
  }

  private async applyTransactionLimits(manager: IngestQueryExecutor): Promise<void> {
    await manager.query(`SET LOCAL lock_timeout = '1s'`);
    await manager.query(`SET LOCAL statement_timeout = '5s'`);
  }

  private async assertTenantNotErased(
    manager: IngestQueryExecutor,
    tenantId: string,
  ): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      tenantErasureFenceLockKey(tenantId, 'sensor-service'),
    ]);
    const rows = requireRows(
      await manager.query(
        `SELECT true AS erased
           FROM "sensor"."tenant_erasure_target_proofs"
          WHERE tenant_id = $1
            AND dry_run = false
          LIMIT 1`,
        [tenantId],
      ),
    );
    if (rows.length > 0) {
      throw new TenantErasureTombstoneError();
    }
  }
}
