import { DURABLE_SENSOR_INGEST_UP_STATEMENTS } from '../1816000000001-AddDurableSensorIngestLedger';

describe('AddDurableSensorIngestLedger1816000000001', () => {
  const ddl = DURABLE_SENSOR_INGEST_UP_STATEMENTS.join('\n');

  it('adds blue-green source identity columns without requiring legacy backfill', () => {
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "source_event_id"');
    expect(ddl).toContain('ADD COLUMN IF NOT EXISTS "source_sequence" bigint');
    expect(ddl).not.toContain('ALTER COLUMN "source_event_id" SET NOT NULL');
  });

  it('creates tenant-local receipt uniqueness and deterministic child dispatch ledgers', () => {
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "sensor_ingest_receipts"');
    expect(ddl).toContain('PRIMARY KEY ("source_event_id")');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "sensor_event_dispatch"');
    expect(ddl).toContain('PRIMARY KEY ("child_event_id")');
    expect(ddl).toContain('REFERENCES "sensor_ingest_receipts" ("source_event_id")');
  });

  it('keeps pending dispatches age-independent and indexes the publisher work queue', () => {
    expect(ddl).toContain("CHECK (\"dispatch_status\" IN ('PENDING', 'ACKED'))");
    expect(ddl).toContain('WHERE "dispatch_status" = \'PENDING\'');
    expect(ddl).not.toContain('DELETE FROM "sensor_event_dispatch"');
  });

  it('persists retry attempts and distinguishes committed from dead-lettered receipts', () => {
    expect(ddl).toContain("CHECK (\"commit_status\" IN ('RETRYING', 'COMMITTED', 'DLQ'))");
    expect(ddl).toContain('"last_error" text');
    expect(ddl).toContain('"committed_at" timestamp with time zone');
    expect(ddl).toContain('"dead_lettered_at" timestamp with time zone');
  });
});
