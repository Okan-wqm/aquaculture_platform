import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
  withDdlSafety,
} from '@aquaculture/backend-common/database';

/**
 * ReinstateFarmTenantErasureAuditOwnership1789500000000
 * ============================================================================
 *
 * Forward repair for environments where 178940 recreated
 * `farm.tenant_erasure_audit`, then strict farm source-schema ownership dropped
 * it as an orphan during service bootstrap before the registry declared it as a
 * farm-owned infrastructure table.
 *
 * Editing 178940 would not affect production because that migration is already
 * recorded as applied. This migration is intentionally narrow: it reinstates
 * the compliance ledger and its immutability trigger, then assigns ownership to
 * the farm service role so the table is part of the farm source-schema contract.
 */
export class ReinstateFarmTenantErasureAuditOwnership1789500000000
  implements MigrationInterface
{
  name = 'ReinstateFarmTenantErasureAuditOwnership1789500000000';

  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    await withDdlSafety(
      queryRunner,
      { schema: 'farm', advisoryLockKeySuffix: this.name },
      async () => {
        this.logger.log(
          'Reinstating farm tenant erasure audit ownership contract.',
        );

        await queryRunner.query(`
          CREATE TABLE IF NOT EXISTS farm.tenant_erasure_audit (
            "tenantId"             uuid PRIMARY KEY,
            "confirmedAt"          timestamptz NOT NULL,
            "requestedBy"          varchar(255) NOT NULL,
            "totalDeleted"         integer NOT NULL,
            "auditRowsAnonymised"  integer NOT NULL,
            "tableCount"           integer NOT NULL,
            "deletedRowsByTable"   jsonb NOT NULL DEFAULT '{}'::jsonb
          )
        `);

        await queryRunner.query(`
          CREATE OR REPLACE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'tenant_erasure_audit rows are immutable; tenantId=%, op=%',
              OLD."tenantId", TG_OP;
          END;
          $$ LANGUAGE plpgsql
        `);

        await queryRunner.query(`
          DROP TRIGGER IF EXISTS trg_tenant_erasure_audit_prevent_update
            ON farm.tenant_erasure_audit
        `);

        await queryRunner.query(`
          CREATE TRIGGER trg_tenant_erasure_audit_prevent_update
            BEFORE UPDATE OR DELETE ON farm.tenant_erasure_audit
            FOR EACH ROW
            EXECUTE FUNCTION farm.tenant_erasure_audit_prevent_mutation()
        `);

        await queryRunner.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'farm_service') THEN
              ALTER TABLE farm.tenant_erasure_audit OWNER TO farm_service;
              ALTER FUNCTION farm.tenant_erasure_audit_prevent_mutation() OWNER TO farm_service;
              GRANT ALL PRIVILEGES ON TABLE farm.tenant_erasure_audit TO farm_service;
            END IF;
          END $$
        `);

        this.logger.log(
          'Farm tenant erasure audit ownership contract reinstated.',
        );
      },
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Down migration intentionally left as no-op: tenant erasure audit ownership repair is forward-only.',
    );
  }
}
