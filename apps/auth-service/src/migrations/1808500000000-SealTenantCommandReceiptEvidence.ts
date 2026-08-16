import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A successful source-owner command receipt is forensic evidence. It may be
 * inserted/advanced while the owner transaction is running, but after success
 * no application role may rewrite or delete the transition it proves.
 */
export class SealTenantCommandReceiptEvidence1808500000000 implements MigrationInterface {
  name = 'SealTenantCommandReceiptEvidence1808500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION auth.prevent_sealed_tenant_command_receipt_mutation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD.status = 'SUCCEEDED' THEN
          RAISE EXCEPTION
            'Successful auth.tenant_command_receipts are immutable forensic evidence';
        END IF;
        RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
      END;
      $$
    `);

    await queryRunner.query(`
      DROP TRIGGER IF EXISTS trg_seal_tenant_command_receipt_evidence
        ON auth.tenant_command_receipts
    `);
    await queryRunner.query(`
      CREATE TRIGGER trg_seal_tenant_command_receipt_evidence
      BEFORE UPDATE OR DELETE ON auth.tenant_command_receipts
      FOR EACH ROW
      EXECUTE FUNCTION auth.prevent_sealed_tenant_command_receipt_mutation()
    `);

    await queryRunner.query(`
      REVOKE DELETE ON auth.tenant_command_receipts FROM PUBLIC
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only evidence seal. Downgrade would reopen a forensic rewrite path.
  }
}
