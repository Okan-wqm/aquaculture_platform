import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ExtendBiomassReportStatusAltinnManual1804000000000
 *
 * Biomass channel honesty (RPT-001). The biomass report is submitted to
 * Fiskeridirektoratet MANUALLY via the Altinn FD-0001 form — the platform has
 * no automated FDIR channel — yet the old lifecycle jumped DRAFT → SUBMITTED,
 * falsely implying an electronic submission. This migration adds the honest
 * intermediate + terminal states and the columns that record the real,
 * operator-confirmed Altinn submission:
 *
 *   biomass_reports_status_enum += 'READY'               (reviewed, ready to export)
 *   biomass_reports_status_enum += 'CONFIRMED_SUBMITTED' (operator confirmed Altinn receipt)
 *   biomass_reports += "readyAt", "altinnReference", "confirmedBy"
 *
 * Legacy 'SUBMITTED' rows are LEFT as-is and treated as terminal-equivalent to
 * CONFIRMED_SUBMITTED by the immutability guard — no data rewrite, so there is
 * no cross-schema enum-ordering hazard.
 *
 * # Tenant fan-out (current_schema-relative)
 *
 * biomass_reports is a per-tenant table and its enum type is created PER-SCHEMA
 * (Baseline in `farm`; 1800100000000 in every tenant_<uuid>). Each ALTER TYPE
 * ADD VALUE is therefore type-presence-guarded in current_schema and runs in
 * every schema that holds the type — safe whether the run is `farm` or a tenant.
 *
 * # transaction = false
 *
 * ALTER TYPE ... ADD VALUE cannot be consumed in the transaction that adds it,
 * so each statement autocommits. Every statement is IF NOT EXISTS / additive,
 * hence idempotent on re-run. Blue-green safe: additive enum values + nullable
 * columns, no NOT NULL backfill.
 */
export class ExtendBiomassReportStatusAltinnManual1804000000000 implements MigrationInterface {
  name = 'ExtendBiomassReportStatusAltinnManual1804000000000';

  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addEnumValueIfTypePresent(queryRunner, 'biomass_reports_status_enum', 'READY');
    await this.addEnumValueIfTypePresent(
      queryRunner,
      'biomass_reports_status_enum',
      'CONFIRMED_SUBMITTED',
    );

    await queryRunner.query(
      `ALTER TABLE "biomass_reports" ADD COLUMN IF NOT EXISTS "readyAt" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "biomass_reports" ADD COLUMN IF NOT EXISTS "altinnReference" varchar(64)`,
    );
    await queryRunner.query(
      `ALTER TABLE "biomass_reports" ADD COLUMN IF NOT EXISTS "confirmedBy" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot DROP an enum VALUE — the added labels remain (harmless).
    await queryRunner.query(`ALTER TABLE "biomass_reports" DROP COLUMN IF EXISTS "confirmedBy"`);
    await queryRunner.query(
      `ALTER TABLE "biomass_reports" DROP COLUMN IF EXISTS "altinnReference"`,
    );
    await queryRunner.query(`ALTER TABLE "biomass_reports" DROP COLUMN IF EXISTS "readyAt"`);
  }

  /**
   * Add an enum VALUE only when its enum TYPE exists in the ACTIVE schema, so
   * the per-schema fan-out is a guarded no-op wherever the type is absent (never
   * a bare ALTER TYPE that would throw 42704). typeName/value are migration
   * literals, not caller input — no injection surface.
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
           WHERE n.nspname = current_schema()
             AND t.typname = '${typeName}'
        ) THEN
          ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS '${value}';
        END IF;
      END
      $$;
    `);
  }
}
