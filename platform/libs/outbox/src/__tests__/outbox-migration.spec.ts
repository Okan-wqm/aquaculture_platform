import { buildOutboxGaugeSql } from '../outbox-gauge-sql';
import {
  buildOutboxDeadLetterIndexDownSql,
  buildOutboxDeadLetterIndexUpSql,
  buildTransactionalOutboxUpSql,
} from '../outbox-migration';

const OPTIONS = {
  schema: 'sensor',
  table: 'sensor_outbox',
  indexName: 'idx_sensor_outbox_dead_letter',
} as const;

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('outbox dead-letter index DDL', () => {
  it('creates a partial index over the unpublished dead-lettered rows only', () => {
    const [sql, ...rest] = buildOutboxDeadLetterIndexUpSql(OPTIONS);

    expect(rest).toHaveLength(0);
    expect(normalize(sql ?? '')).toBe(
      'CREATE INDEX IF NOT EXISTS "idx_sensor_outbox_dead_letter" ' +
        'ON "sensor"."sensor_outbox" ("createdAt") ' +
        'WHERE "publishedAt" IS NULL AND "isDeadLettered" = true',
    );
  });

  it('drops that index by its schema-qualified name', () => {
    expect(buildOutboxDeadLetterIndexDownSql(OPTIONS).map(normalize)).toEqual([
      'DROP INDEX IF EXISTS "sensor"."idx_sensor_outbox_dead_letter"',
    ]);
  });

  it.each([
    ['schema', { ...OPTIONS, schema: 'sensor; DROP SCHEMA public' }],
    ['table', { ...OPTIONS, table: 'sensor_outbox"--' }],
    ['index name', { ...OPTIONS, indexName: 'idx dead' }],
  ])('refuses an unsafe %s identifier', (_label, options) => {
    expect(() => buildOutboxDeadLetterIndexUpSql(options)).toThrow(/safe SQL identifier/);
    expect(() => buildOutboxDeadLetterIndexDownSql(options)).toThrow(/safe SQL identifier/);
  });
});

// The gauge refresh runs on a table that keeps published rows for days. Each
// of its counts is only cheap if Postgres can serve it from a partial index,
// and it only does that when the query's WHERE spells the index predicate. Pin
// the three spellings together so one cannot change without the others.
describe('outbox gauge SQL and the partial indexes that serve it', () => {
  const POLL_PREDICATE = '"publishedAt" IS NULL AND "isDeadLettered" = false';
  const DEAD_LETTER_PREDICATE = '"publishedAt" IS NULL AND "isDeadLettered" = true';

  it('spells the poll-index predicate in the pending and oldest-pending sub-selects', () => {
    const [pollIndexSql] = buildTransactionalOutboxUpSql({
      schema: 'sensor',
      table: 'sensor_outbox',
      pollIndexName: 'idx_sensor_outbox_poll',
      tenantIndexName: 'idx_sensor_outbox_tenant',
      idempotencyIndexName: 'idx_sensor_outbox_idempotency',
      notifyFunctionName: 'notify_sensor_outbox_new',
      notifyTriggerName: 'sensor_outbox_notify_trigger',
      notifyChannel: 'sensor_outbox_notify',
    }).filter((sql) => sql.includes('idx_sensor_outbox_poll'));

    expect(normalize(pollIndexSql ?? '')).toContain(`WHERE ${POLL_PREDICATE}`);

    const gauge = normalize(buildOutboxGaugeSql('sensor_outbox'));
    expect(gauge.split(POLL_PREDICATE)).toHaveLength(3); // pending + oldest pending
  });

  it('spells the dead-letter-index predicate in the dead-letter sub-select', () => {
    const [deadLetterIndexSql] = buildOutboxDeadLetterIndexUpSql(OPTIONS);
    expect(normalize(deadLetterIndexSql ?? '')).toContain(`WHERE ${DEAD_LETTER_PREDICATE}`);

    const gauge = normalize(buildOutboxGaugeSql('sensor_outbox'));
    expect(gauge.split(DEAD_LETTER_PREDICATE)).toHaveLength(2);
  });

  it('never binds the dead-letter flag as a parameter', () => {
    expect(buildOutboxGaugeSql('sensor_outbox')).not.toMatch(/"isDeadLettered"\s*=\s*\$/);
  });
});
