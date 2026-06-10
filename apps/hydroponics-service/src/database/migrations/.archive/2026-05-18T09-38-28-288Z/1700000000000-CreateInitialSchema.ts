import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  pinSearchPath,
  dropPartialTables,
  MigrationLogger,
} from '@aquaculture/backend-common/database';

/**
 * CreateInitialSchema1700000000000 — hydroponics-service baseline.
 * ============================================================================
 *
 * Bootstraps the source `hydroponics` schema with the single table that
 * `hydroponics-service` owns today: `hydroponics_config`.
 *
 * # Why this migration exists
 *
 * Prior to Wave 4-A.2, hydroponics-service had no migrations directory.
 * The `HydroponicsConfig` entity was registered in TypeORM but had no
 * DDL counterpart, so a fresh-volume bootstrap left the source schema
 * empty and `TenantSchemaSyncService` had nothing to clone into
 * `tenant_<uuid>` schemas at tenant onboarding. The first request that
 * touched the entity crashed with `relation "hydroponics_config" does
 * not exist`. The schema-registry already had a forward-declared
 * placeholder entry for hydroponics-service (apps/db-migrate/src/
 * schema-registry.ts) anticipating exactly this gap.
 *
 * # Per-tenant table placement
 *
 * `HydroponicsConfig` (apps/hydroponics-service/src/setup/entities/
 * hydroponics-config.entity.ts) deliberately omits the `schema:` option
 * on its `@Entity()` decorator: the table is per-tenant (cloned from
 * source schema `hydroponics` into each `tenant_<uuid>` schema by
 * TenantSchemaSyncService at provisioning time). Migrations therefore:
 *
 *   1. CREATE SCHEMA IF NOT EXISTS hydroponics — defensive guard for
 *      direct CLI runs against a bare database. The infrastructure
 *      init scripts also create the schema, so this is a no-op in the
 *      normal compose flow.
 *   2. SET search_path TO hydroponics, public via pinSearchPath — every
 *      unqualified CREATE TABLE / INDEX below resolves to the source
 *      schema.
 *   3. Heal partial-skeleton tables (a CREATE TABLE that committed
 *      before a later DDL aborted) via dropPartialTables, using
 *      `tenant_id` as the signature column.
 *   4. Issue unqualified DDL — search_path makes it land in
 *      `hydroponics.*`, and TenantSchemaSyncService's
 *      `CREATE TABLE LIKE INCLUDING ALL` later replays it into each
 *      tenant schema.
 *
 * # TIMESTAMPTZ for date columns
 *
 * The platform's timestamptz-only invariant
 * (ConvertTimestampToTimestamptz1781100000000 in auth-service) requires
 * every date column to be TIMESTAMPTZ from creation. The entity's
 * @CreateDateColumn / @UpdateDateColumn decorators map to TIMESTAMPTZ at
 * DDL emit time.
 *
 * Closes: docs/plans/bootstrap-restoration-and-factory-reset-2026-05-07.md
 */

const HYDROPONICS_PARTIAL_STATE_TABLES = ['hydroponics_config'] as const;

export class CreateInitialSchema1700000000000 implements MigrationInterface {
  name = 'CreateInitialSchema1700000000000';
  private readonly logger = new MigrationLogger(this.name);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Creating baseline hydroponics.hydroponics_config table.',
    );

    // Defensive: schema is normally created by infrastructure init
    // scripts before any service container starts. CREATE SCHEMA IF NOT
    // EXISTS makes a direct CLI run against a bare DB succeed too.
    await queryRunner.query(`CREATE SCHEMA IF NOT EXISTS "hydroponics"`);

    // Pin search_path so unqualified DDL resolves into the source schema.
    await pinSearchPath(queryRunner, 'hydroponics');

    // Heal partial-skeleton tables left behind by a prior crashed run.
    // `tenant_id` is the signature column — every hydroponics_config row
    // carries it by entity contract (NOT NULL), so its absence indicates
    // a CREATE TABLE that committed before the post-create DDL ran.
    await dropPartialTables(
      queryRunner,
      'hydroponics',
      HYDROPONICS_PARTIAL_STATE_TABLES,
      'tenant_id',
    );

    // hydroponics_config — per-tenant configuration row. Mirrors the
    // entity at apps/hydroponics-service/src/setup/entities/
    // hydroponics-config.entity.ts. `(tenant_id, config_name)` UNIQUE
    // matches the @Unique(['tenantId', 'configName']) decorator.
    // Index matches the @Index() on tenantId — bundled with CREATE TABLE
    // in the same chunk so migration-sql-lint R3 (just-created-table
    // exemption) recognizes the index target as empty at creation time.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "hydroponics_config" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" UUID NOT NULL,
        "config_name" VARCHAR(255) NOT NULL DEFAULT 'Default',
        "settings" JSONB NOT NULL DEFAULT '{}'::jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_hydroponics_config_tenant_name"
          UNIQUE ("tenant_id", "config_name")
      );
      CREATE INDEX IF NOT EXISTS "IDX_hydroponics_config_tenant"
        ON "hydroponics_config" ("tenant_id");
    `);

    this.logger.log(
      'Baseline hydroponics schema initialised (1 table, 1 unique constraint, 1 index).',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting baseline hydroponics.hydroponics_config table. ' +
        'This is destructive and is intended for ephemeral test environments only.',
    );

    // Schema-qualified drop — search_path is not pinned in the down path
    // because we want this to be unambiguous regardless of caller state.
    await queryRunner.query(
      `DROP TABLE IF EXISTS "hydroponics"."hydroponics_config" CASCADE`,
    );
  }
}
