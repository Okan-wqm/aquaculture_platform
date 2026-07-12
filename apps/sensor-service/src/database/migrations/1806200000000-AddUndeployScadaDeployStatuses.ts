import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WF-011 — undeploy-on-delete for SCADA packages.
 *
 * Deleting a package now sends a best-effort `undeploy_scada_package`
 * command to every device the deploy logs say it runs on. That flow needs
 * two new deploy-log statuses:
 *   - 'undeploy_sent'  — the undeploy command was published to the device
 *   - 'undeployed'     — the device acked that the package was cleared
 * ('rolled_back' is semantically wrong for both: nothing is restored).
 *
 * # Fan-out / schema placement
 * db-migrate re-runs this file per schema with `search_path` pinned. The
 * enum type may exist only in the service schema (Baseline creates it
 * `sensor`-qualified) while tenant_<uuid> runs see no local copy — a bare
 * `ALTER TYPE` there throws 42704 and fails the deploy. Each ALTER is
 * therefore type-presence-guarded in current_schema, exactly as
 * AddCullMortalityAuditEnumValues1801300000000 (farm) guards its own.
 *
 * # Blue-green safety
 * Additive enum values are inherently blue-green safe (no backfill). Old
 * code ignores the extra labels; new code ships only after db-migrate ran.
 * ALTER TYPE ... ADD VALUE cannot be consumed in the transaction that adds
 * it, so this migration runs with statement-level autocommit
 * (`transaction = false`); every statement is IF-NOT-EXISTS-idempotent.
 */
export class AddUndeployScadaDeployStatuses1806200000000 implements MigrationInterface {
  name = 'AddUndeployScadaDeployStatuses1806200000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'scada_deploy_logs_status_enum',
      'undeploy_sent',
    );
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'scada_deploy_logs_status_enum',
      'undeployed',
    );
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema
   * (skips the per-tenant fan-out runs where the type is absent).
   * typeName/value are migration-internal literals (not caller input), so
   * direct interpolation carries no injection surface.
   */
  private async addEnumValueIfTypePresent(
    queryRunner: QueryRunner,
    typeName: string,
    value: string,
  ): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = '${typeName}'
            AND n.nspname = current_schema()
        ) THEN
          ALTER TYPE ${typeName} ADD VALUE IF NOT EXISTS '${value}';
        END IF;
      END $$;
    `);
  }

  public async down(): Promise<void> {
    // Deliberate no-op: PostgreSQL cannot drop enum VALUES. The labels are
    // additive and harmless when unused; removing them would require a
    // type rebuild + table rewrite, which is not blue-green safe.
  }
}
