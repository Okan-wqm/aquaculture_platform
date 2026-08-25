import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tenant-local durability boundary for QoS1 telemetry. Statements remain
 * unqualified intentionally: the tenant migration runner pins search_path to
 * exactly one validated tenant schema before replaying sensor migrations.
 */
export const DURABLE_SENSOR_INGEST_UP_STATEMENTS = [
  `ALTER TABLE IF EXISTS "sensor_metrics"
     ADD COLUMN IF NOT EXISTS "source_event_id" character varying(160)`,
  `ALTER TABLE IF EXISTS "sensor_metrics"
     ADD COLUMN IF NOT EXISTS "source_sequence" bigint`,
  `CREATE INDEX IF NOT EXISTS "idx_sensor_metrics_source_event_id"
     ON "sensor_metrics" ("source_event_id")
     WHERE "source_event_id" IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS "sensor_ingest_receipts" (
     "source_event_id" character varying(160) NOT NULL,
     "payload_digest" character(64) NOT NULL,
     "mqtt_topic" text NOT NULL,
     "source_timestamp" timestamp with time zone NOT NULL,
     "source_sequence" bigint,
     "commit_status" character varying(16) NOT NULL DEFAULT 'COMMITTED',
     "processing_attempts" integer NOT NULL DEFAULT 1,
     "last_error" text,
     "committed_at" timestamp with time zone DEFAULT now(),
     "dead_lettered_at" timestamp with time zone,
     "created_at" timestamp with time zone NOT NULL DEFAULT now(),
     CONSTRAINT "PK_sensor_ingest_receipts" PRIMARY KEY ("source_event_id"),
     CONSTRAINT "CHK_sensor_ingest_receipts_digest"
       CHECK ("payload_digest" ~ '^[0-9a-f]{64}$'),
     CONSTRAINT "CHK_sensor_ingest_receipts_status"
       CHECK ("commit_status" IN ('RETRYING', 'COMMITTED', 'DLQ')),
     CONSTRAINT "CHK_sensor_ingest_receipts_attempts"
       CHECK ("processing_attempts" > 0),
     CONSTRAINT "CHK_sensor_ingest_receipts_state"
       CHECK (
         ("commit_status" = 'RETRYING' AND "committed_at" IS NULL
           AND "dead_lettered_at" IS NULL AND "last_error" IS NOT NULL)
         OR
         ("commit_status" = 'COMMITTED' AND "committed_at" IS NOT NULL
           AND "dead_lettered_at" IS NULL AND "last_error" IS NULL)
         OR
         ("commit_status" = 'DLQ' AND "committed_at" IS NULL
           AND "dead_lettered_at" IS NOT NULL AND "last_error" IS NOT NULL)
       )
   )`,
  `CREATE TABLE IF NOT EXISTS "sensor_event_dispatch" (
     "child_event_id" uuid NOT NULL,
     "source_event_id" character varying(160) NOT NULL,
     "subject" text NOT NULL,
     "payload" jsonb NOT NULL,
     "dispatch_status" character varying(16) NOT NULL DEFAULT 'PENDING',
     "puback_stream" text,
     "puback_sequence" bigint,
     "attempt_count" integer NOT NULL DEFAULT 0,
     "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
     "last_error" text,
     "created_at" timestamp with time zone NOT NULL DEFAULT now(),
     "acked_at" timestamp with time zone,
     CONSTRAINT "PK_sensor_event_dispatch" PRIMARY KEY ("child_event_id"),
     CONSTRAINT "FK_sensor_event_dispatch_receipt"
       FOREIGN KEY ("source_event_id")
       REFERENCES "sensor_ingest_receipts" ("source_event_id") ON DELETE CASCADE,
     CONSTRAINT "CHK_sensor_event_dispatch_status"
       CHECK ("dispatch_status" IN ('PENDING', 'ACKED')),
     CONSTRAINT "CHK_sensor_event_dispatch_attempts"
       CHECK ("attempt_count" >= 0),
     CONSTRAINT "CHK_sensor_event_dispatch_puback"
       CHECK (
         ("dispatch_status" = 'PENDING' AND "puback_stream" IS NULL
           AND "puback_sequence" IS NULL AND "acked_at" IS NULL)
         OR
         ("dispatch_status" = 'ACKED' AND "puback_stream" IS NOT NULL
           AND "puback_sequence" IS NOT NULL AND "acked_at" IS NOT NULL)
       )
   )`,
  `CREATE INDEX IF NOT EXISTS "idx_sensor_event_dispatch_pending"
     ON "sensor_event_dispatch" ("next_attempt_at", "created_at")
     WHERE "dispatch_status" = 'PENDING'`,
  `CREATE INDEX IF NOT EXISTS "idx_sensor_event_dispatch_acked_retention"
     ON "sensor_event_dispatch" ("acked_at")
     WHERE "dispatch_status" = 'ACKED'`,
] as const;

export class AddDurableSensorIngestLedger1816000000001 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const statement of DURABLE_SENSOR_INGEST_UP_STATEMENTS) {
      await queryRunner.query(statement);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    throw new Error(
      'Durable sensor ingest ledgers are forward-only; rollback must preserve receipts and pending dispatches',
    );
  }
}
