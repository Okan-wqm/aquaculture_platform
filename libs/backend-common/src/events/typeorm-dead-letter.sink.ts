import { createHash } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

import { isValidUUID } from '../database/tenant-schema.utils';

import {
  DEAD_LETTER_SINK_OPTIONS,
  type DeadLetterEnvelope,
  type DeadLetterSink,
  type DeadLetterSinkOptions,
} from './dead-letter.contract';

const MAX_ERROR_LENGTH = 4000;

function assertSqlIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || value.length > 63) {
    throw new Error(`Dead-letter sink ${label} must be a safe SQL identifier, got: ${value}`);
  }
  return value;
}

function stableDeliveryKey(source: string, entry: DeadLetterEnvelope): string {
  return createHash('sha256')
    .update(source)
    .update('\0')
    .update(entry.subject)
    .update('\0')
    .update(entry.eventId ?? JSON.stringify(entry.payload))
    .digest('hex');
}

@Injectable()
export class TypeormDeadLetterSink implements DeadLetterSink {
  private readonly logger = new Logger(TypeormDeadLetterSink.name);
  private readonly qualifiedTable: string;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Inject(DEAD_LETTER_SINK_OPTIONS)
    private readonly options: DeadLetterSinkOptions,
  ) {
    const schema = assertSqlIdentifier(options.schema, 'schema');
    assertSqlIdentifier(options.source.replaceAll('-', '_'), 'source');
    this.qualifiedTable = `"${schema}"."event_dlq"`;
  }

  /**
   * The advisory transaction lock plus the existence predicate makes retrying
   * the same terminal delivery converge on one row even on the legacy shared
   * event_dlq shape, without introducing a second per-service identity schema.
   */
  async record(entry: DeadLetterEnvelope): Promise<void> {
    const deliveryKey = stableDeliveryKey(this.options.source, entry);
    await this.dataSource.transaction(async (manager: EntityManager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [deliveryKey]);
      await manager.query(
        `INSERT INTO ${this.qualifiedTable}
           ("source", "tenantId", "eventId", "eventType", "payload", "error", "retryCount", "metadata")
         SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb
          WHERE NOT EXISTS (
            SELECT 1
              FROM ${this.qualifiedTable}
             WHERE "source" = $1
               AND "eventId" IS NOT DISTINCT FROM $3
               AND "metadata"->>'deliveryKey' = $9
          )`,
        [
          this.options.source,
          entry.tenantId !== undefined && isValidUUID(entry.tenantId) ? entry.tenantId : null,
          entry.eventId !== undefined && isValidUUID(entry.eventId) ? entry.eventId : null,
          entry.eventType.slice(0, 100),
          JSON.stringify(entry.payload),
          entry.error.slice(0, MAX_ERROR_LENGTH),
          entry.deliveryCount,
          JSON.stringify({ subject: entry.subject, deliveryKey }),
          deliveryKey,
        ],
      );
    });

    this.logger.error(
      `Dead-lettered ${entry.eventType} after ${entry.deliveryCount} delivery attempt(s) ` +
        `on ${entry.subject} into ${this.options.schema}.event_dlq`,
    );
  }
}
