import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';
import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@SourceOnlyMigration({
  reason:
    'messaging_outbox is source-owned infrastructure and must never be cloned into tenant schemas',
})
export class CreateMessagingOutboxTable1800200000000
  implements MigrationInterface
{
  name = 'CreateMessagingOutboxTable1800200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'messaging');

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS messaging.messaging_outbox (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "eventType" VARCHAR(100) NOT NULL,
        "tenantId" UUID NULL,
        "aggregateId" UUID NULL,
        "payload" JSONB NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "publishedAt" TIMESTAMPTZ NULL,
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "lastError" TEXT NULL,
        "nextAttemptAt" TIMESTAMPTZ NULL,
        "idempotencyKey" VARCHAR(255) NULL,
        "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
        "leasedAt" TIMESTAMPTZ NULL,
        "leasedBy" VARCHAR(128) NULL
      )
    `);

    await queryRunner.query(`
      DO $$
      DECLARE
        id_type text;
        outbox_rows bigint;
      BEGIN
        SELECT data_type
          INTO id_type
          FROM information_schema.columns
         WHERE table_schema = 'messaging'
           AND table_name = 'messaging_outbox'
           AND column_name = 'id';

        IF id_type IN ('bigint', 'integer') THEN
          EXECUTE 'SELECT count(*) FROM messaging.messaging_outbox'
            INTO outbox_rows;

          IF outbox_rows > 0 THEN
            RAISE EXCEPTION
              'messaging_outbox id is %, but canonical PK is uuid; drain or explicitly remediate existing outbox rows before applying 180020',
              id_type;
          END IF;

          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" DROP IDENTITY IF EXISTS;
          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" DROP DEFAULT;
          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" TYPE UUID USING gen_random_uuid();
          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE messaging.messaging_outbox
        ADD COLUMN IF NOT EXISTS "tenantId" UUID,
        ADD COLUMN IF NOT EXISTS "aggregateId" UUID,
        ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "idempotencyKey" VARCHAR(255),
        ADD COLUMN IF NOT EXISTS "isDeadLettered" BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "leasedAt" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "leasedBy" VARCHAR(128)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_poll"
        ON messaging.messaging_outbox ("createdAt")
        WHERE "publishedAt" IS NULL AND "isDeadLettered" = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_tenant"
        ON messaging.messaging_outbox ("tenantId")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_outbox_idempotency"
        ON messaging.messaging_outbox ("tenantId", "idempotencyKey")
        WHERE "idempotencyKey" IS NOT NULL
    `);
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: 'messaging',
      tenantIndexName: 'idx_messaging_erasure_proofs_tenant',
      eventIndexName: 'idx_messaging_erasure_proofs_event',
      targetIndexName: 'idx_messaging_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const idRows: unknown = await queryRunner.query(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'messaging'
          AND table_name = 'messaging_outbox'
          AND column_name = 'id'`,
    );
    const idRow: unknown = Array.isArray(idRows) ? idRows[0] : undefined;
    if (!isRecord(idRow) || idRow['data_type'] !== 'uuid') {
      return false;
    }

    const tenantRows: unknown = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
          AND table_name = 'messaging_outbox'`,
    );
    const tenantRow: unknown = Array.isArray(tenantRows)
      ? tenantRows[0]
      : undefined;
    const tenantCount = isRecord(tenantRow) ? tenantRow['count'] : '0';

    return Number(tenantCount) === 0;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: 'messaging',
      tenantIndexName: 'idx_messaging_erasure_proofs_tenant',
      eventIndexName: 'idx_messaging_erasure_proofs_event',
      targetIndexName: 'idx_messaging_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    // Forward-only repair: this table may already exist in deployed databases.
  }
}
