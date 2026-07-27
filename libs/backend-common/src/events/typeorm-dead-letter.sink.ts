/**
 * TypeormDeadLetterSink (W7, FARM-MEDIUM-260)
 *
 * The one implementation of {@link DeadLetterSink} on the platform: writes the
 * dropped message into the owning service's `<schema>.event_dlq` row shape
 * built by `@platform/outbox`'s `buildEventDlqUpSql`. One writer, one shape,
 * every service — an operator's replay query is the same everywhere.
 *
 * `event_dlq` is CROSS-TENANT infrastructure (it is listed in the service's
 * `MODULE_SCHEMAS[].infrastructureTables`), so the insert is schema-qualified
 * and does NOT ride the tenant `search_path`: a failure that happened while a
 * tenant context was active must still land on the platform shelf, not in a
 * tenant clone that the operator never looks at.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { isValidUUID } from '../database/tenant-schema.utils';

import {
  DEAD_LETTER_SINK_OPTIONS,
  type DeadLetterEnvelope,
  type DeadLetterSink,
  type DeadLetterSinkOptions,
} from './dead-letter.contract';

/**
 * Schema/source come from module configuration, never from a message, but the
 * schema still reaches SQL as an identifier (identifiers cannot be bound as
 * parameters). Validating at construction makes an injectable identifier
 * structurally impossible rather than merely unlikely.
 */
function assertSqlIdentifier(value: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value) || value.length > 63) {
    throw new Error(`Dead-letter sink ${label} must be a safe SQL identifier, got: ${value}`);
  }
  return value;
}

/** `error` is TEXT but an unbounded stack would bloat the shelf. */
const MAX_ERROR_LENGTH = 4000;

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
    this.qualifiedTable = `"${assertSqlIdentifier(options.schema, 'schema')}"."event_dlq"`;
  }

  /**
   * @throws when the row cannot be written — the caller (NatsEventBus) keeps
   *   the message in JetStream rather than terminating it, so a broken shelf
   *   degrades to redelivery, never to loss.
   */
  async record(entry: DeadLetterEnvelope): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO ${this.qualifiedTable}
         ("source", "tenantId", "eventId", "eventType", "payload", "error", "retryCount", "metadata")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb)`,
      [
        this.options.source,
        // The columns are UUID-typed: a malformed id must become NULL rather
        // than abort the insert — losing the id is survivable, losing the row
        // is the failure mode this whole shelf exists to prevent.
        entry.tenantId !== undefined && isValidUUID(entry.tenantId) ? entry.tenantId : null,
        entry.eventId !== undefined && isValidUUID(entry.eventId) ? entry.eventId : null,
        entry.eventType.slice(0, 100),
        JSON.stringify(entry.payload),
        entry.error.slice(0, MAX_ERROR_LENGTH),
        entry.deliveryCount,
        JSON.stringify({ subject: entry.subject }),
      ],
    );

    this.logger.error(
      `Dead-lettered ${entry.eventType} after ${entry.deliveryCount} delivery attempt(s) ` +
        `on ${entry.subject} — row written to ${this.options.schema}.event_dlq`,
      {
        eventType: entry.eventType,
        eventId: entry.eventId,
        subject: entry.subject,
        deliveryCount: entry.deliveryCount,
        source: this.options.source,
      },
    );
  }
}
