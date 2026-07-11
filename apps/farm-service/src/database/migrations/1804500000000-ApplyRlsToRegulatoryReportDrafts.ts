import { applyTenantRlsToSchema } from '@aquaculture/backend-common/database';
import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLE = 'regulatory_report_drafts';

/**
 * REG-HIGH-002 — `regulatory_report_drafts` shipped (1803600000000) without the
 * FORCE ROW LEVEL SECURITY backstop its sibling `regulatory_reports` carries, even
 * though it holds the richest per-tenant operational dataset in the subsystem (the
 * fully-assembled Mattilsynet payloads — lice counts, treatments, biomass,
 * slaughter). Today only search_path + the `where: { tenantId }` column filter
 * protect it; a future query that omits the tenantId predicate while search_path is
 * mis-routed would read another tenant's assembled reports. This migration adds the
 * same tenant RLS policy the reports table has, so the tenant boundary is enforced
 * at the row level regardless of the application query shape. Idempotent,
 * forward-only, fanned out to farm + every tenant schema by the runner.
 */
export class ApplyRlsToRegulatoryReportDrafts1804500000000 implements MigrationInterface {
  name = 'ApplyRlsToRegulatoryReportDrafts1804500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await applyTenantRlsToSchema(queryRunner, {
      includeTables: [TABLE],
      tenantIdColumns: ['tenantId'],
    });
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // The table only exists in schemas that have run 1803600000000; where it
    // exists, assert FORCE RLS is on. (to_regclass is NULL-safe for schemas that
    // do not yet carry the table.)
    const rows = (await queryRunner.query(`
      SELECT
        to_regclass(current_schema() || '.${TABLE}') IS NULL
        OR EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema()
            AND c.relname = '${TABLE}'
            AND c.relrowsecurity = true
            AND c.relforcerowsecurity = true
        ) AS ok
    `)) as Array<{ ok: boolean }>;

    return rows[0]?.ok === true;
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Forward-only: a tenant-isolation policy is never rolled back.
  }
}
