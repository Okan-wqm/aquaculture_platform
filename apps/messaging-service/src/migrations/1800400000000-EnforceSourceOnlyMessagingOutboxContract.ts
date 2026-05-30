import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  pinSearchPath,
  SourceOnlyMigration,
} from '@aquaculture/backend-common/database';

@SourceOnlyMigration({
  reason:
    'messaging_outbox is source-owned infrastructure; upgrade paths must keep the canonical UUID PK and reject tenant-schema clones',
})
export class EnforceSourceOnlyMessagingOutboxContract1800400000000
  implements MigrationInterface
{
  name = 'EnforceSourceOnlyMessagingOutboxContract1800400000000';

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
        tenant_outbox_count bigint;
      BEGIN
        SELECT count(*)
          INTO tenant_outbox_count
          FROM information_schema.tables
         WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
           AND table_name = 'messaging_outbox';

        IF tenant_outbox_count > 0 THEN
          RAISE EXCEPTION
            'messaging_outbox exists in % tenant schema(s); remove tenant clones via audited remediation before applying 180040',
            tenant_outbox_count;
        END IF;

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
              'messaging_outbox id is %, but canonical PK is uuid; drain outbox rows or run audited id remapping before applying 180040',
              id_type;
          END IF;

          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" DROP DEFAULT;
          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" TYPE UUID USING gen_random_uuid();
          ALTER TABLE messaging.messaging_outbox
            ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
        END IF;

        IF id_type IS NOT NULL AND id_type NOT IN ('uuid', 'bigint', 'integer') THEN
          RAISE EXCEPTION
            'messaging_outbox id has unsupported type %; expected uuid',
            id_type;
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
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const idRows: Array<{ data_type: string }> = await queryRunner.query(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_schema = 'messaging'
          AND table_name = 'messaging_outbox'
          AND column_name = 'id'`,
    );
    if (idRows[0]?.data_type !== 'uuid') {
      return false;
    }

    const tenantRows: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM information_schema.tables
        WHERE table_schema ~ '^tenant_[a-f0-9]{16}$'
          AND table_name = 'messaging_outbox'`,
    );

    return Number(tenantRows[0]?.count ?? '0') === 0;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only contract enforcement; rollback would risk reintroducing tenant outbox drift.
  }
}
