import {
  buildTenantErasureTargetProofLedgerDownSql,
  buildTenantErasureTargetProofLedgerUpSql,
} from '@platform/outbox';
import { MigrationInterface, QueryRunner } from 'typeorm';

import { quoteIdent, quoteQualified } from './hr-owned-entities';

const HR_SCHEMA = 'hr';
const HR_OUTBOX_TABLE = 'hr_outbox';
const HR_OUTBOX = quoteQualified(HR_SCHEMA, HR_OUTBOX_TABLE);
const HR_OUTBOX_COLUMNS = {
  createdAt: quoteIdent('createdAt', 'column'),
  idempotencyKey: quoteIdent('idempotencyKey', 'column'),
  isDeadLettered: quoteIdent('isDeadLettered', 'column'),
  publishedAt: quoteIdent('publishedAt', 'column'),
  tenantId: quoteIdent('tenantId', 'column'),
} as const;
const HR_OUTBOX_INDEXES = {
  idempotency: 'idx_hr_outbox_idempotency',
  poll: 'idx_hr_outbox_poll',
  tenant: 'idx_hr_outbox_tenant',
} as const;

export class AddHrOutboxIdempotencyIndex1800200000000 implements MigrationInterface {
  name = 'AddHrOutboxIdempotencyIndex1800200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdent(HR_OUTBOX_INDEXES.poll, 'index')}
        ON ${HR_OUTBOX} (${HR_OUTBOX_COLUMNS.createdAt})
        WHERE ${HR_OUTBOX_COLUMNS.publishedAt} IS NULL
          AND ${HR_OUTBOX_COLUMNS.isDeadLettered} = false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdent(HR_OUTBOX_INDEXES.tenant, 'index')}
        ON ${HR_OUTBOX} (${HR_OUTBOX_COLUMNS.tenantId})
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(HR_OUTBOX_INDEXES.idempotency, 'index')}
        ON ${HR_OUTBOX} (${HR_OUTBOX_COLUMNS.tenantId}, ${HR_OUTBOX_COLUMNS.idempotencyKey})
        WHERE ${HR_OUTBOX_COLUMNS.idempotencyKey} IS NOT NULL
    `);
    for (const sql of buildTenantErasureTargetProofLedgerUpSql({
      schema: HR_SCHEMA,
      tenantIndexName: 'idx_hr_erasure_proofs_tenant',
      eventIndexName: 'idx_hr_erasure_proofs_event',
      targetIndexName: 'idx_hr_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of buildTenantErasureTargetProofLedgerDownSql({
      schema: HR_SCHEMA,
      tenantIndexName: 'idx_hr_erasure_proofs_tenant',
      eventIndexName: 'idx_hr_erasure_proofs_event',
      targetIndexName: 'idx_hr_erasure_proofs_target',
    })) {
      await queryRunner.query(sql);
    }
    await queryRunner.query(
      `DROP INDEX IF EXISTS ${quoteQualified(HR_SCHEMA, HR_OUTBOX_INDEXES.idempotency)}`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS ${quoteQualified(HR_SCHEMA, HR_OUTBOX_INDEXES.tenant)}`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS ${quoteQualified(HR_SCHEMA, HR_OUTBOX_INDEXES.poll)}`,
    );
  }
}
