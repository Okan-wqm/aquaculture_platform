import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignFarmEntitySurface1789000000000
 * ============================================================================
 *
 * Closes the entity-vs-baseline drift on `farm.sites` flagged by the
 * bootstrap-from-scratch invariant: 12 columns the Site entity declares
 * but the baseline `CreateInitialSchema1700000000000` never created, plus
 * 2 missing indexes (entity declares 8 `@Index` entries; `pg_indexes`
 * shows only 6 — including the PK index).
 *
 * # Why this migration exists (not a baseline rewrite)
 *
 * The baseline faithfully reproduces the legacy
 * `infrastructure/docker/init-scripts/03-farm-tables-and-seed.sql` `sites`
 * table — that boundary is owned by the init-script-restoration work
 * (Wave 4-A.2 bootstrap-restoration). The Site entity has organically
 * grown beyond that legacy shape: type, city, areaM2/waterCapacityM3/
 * maxBiomassKg, establishedDate, facilities, notes, metadata, soft-delete
 * trio.
 *
 * Rewriting the baseline to add these columns would obscure the
 * init-script heritage. The architectural pattern across the platform is:
 * baselines preserve historical truth, alignment migrations land
 * subsequent entity-driven changes.
 *
 * # Why the failure surfaces only on fresh-volume bootstraps
 *
 * Existing droplet volumes already carry these columns from earlier
 * deploys. Fresh-volume CI runs and DR rebuilds get only what the
 * baseline produces, so they fail the entity-vs-DB drift assertion.
 *
 * # Idempotency
 *
 *   - `CREATE TYPE ... AS ENUM` wrapped in `DO $$ BEGIN ... EXCEPTION
 *     WHEN duplicate_object THEN NULL; END $$` (R8 + R5).
 *   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for every column (R9).
 *   - `CREATE INDEX IF NOT EXISTS` for every new index (R3).
 *
 * # Why `ADD COLUMN ... NOT NULL DEFAULT <literal>` is safe
 *
 * Two columns land NOT NULL: `type` (DEFAULT 'land_based') and
 * `isDeleted` (DEFAULT false). On PG ≥ 11 a non-volatile literal default
 * for ADD COLUMN is metadata-only — no full table rewrite, no row-by-row
 * default fill, no ACCESS EXCLUSIVE stall.
 *
 * # Index count math (closes the "8 declared, 6 present" drift)
 *
 * Site entity declares 8 `@Index` entries:
 *   1. `[tenantId, code]` UNIQUE         — present as UQ_sites_tenant_code
 *   2. `[tenantId, name]` UNIQUE         — present as UQ_sites_tenant_name
 *   3. `[tenantId, status]`              — present as IDX_sites_tenant_status
 *   4. `[tenantId, type]`                — MISSING (column was missing too)
 *   5. `[tenantId, isActive]`            — present as IDX_sites_tenant_isActive
 *   6. `tenantId` (column-level)         — present as IDX_sites_tenantId
 *   7. `isActive` (column-level)         — leftmost-prefix on
 *                                          IDX_sites_tenant_isActive
 *   8. `isDeleted` (column-level)        — MISSING (column was missing too)
 *
 * Adding `IDX_sites_tenant_type` and `IDX_sites_isDeleted` raises the
 * pg_indexes count from 6 to 8.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignFarmEntitySurface1789000000000 implements MigrationInterface {
  name = 'AlignFarmEntitySurface1789000000000';

  private readonly logger = new MigrationLogger(
    'AlignFarmEntitySurface1789000000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    this.logger.log(
      'Aligning farm.sites with the Site entity surface — 12 columns + 2 indexes.',
    );

    // 1) Enum type for the new `type` column.
    // TypeORM auto-derives the enum type name as `<table>_<column>_enum`.
    // PostgreSQL has no `CREATE TYPE IF NOT EXISTS`; the DO/EXCEPTION wrap
    // with `WHEN duplicate_object` is the canonical idempotency shape
    // (R8 + R5 — note R5 forbids `WHEN others`).
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE farm.sites_type_enum AS ENUM (
          'land_based',
          'sea_cage',
          'pond',
          'raceway',
          'recirculating',
          'hatchery'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);

    // 2) Add the 12 missing columns. Types/nullability/defaults derive
    //    directly from the entity decorators in
    //    `apps/farm-service/src/site/entities/site.entity.ts`.

    // type — @Column({ type: 'enum', enum: SiteType, default: SiteType.LAND_BASED })
    // No `nullable: true` → NOT NULL with the LAND_BASED literal default.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "type" farm.sites_type_enum NOT NULL DEFAULT 'land_based'
    `);

    // city — @Column({ length: 100, nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "city" varchar(100)
    `);

    // areaM2 — @Column({ type: 'decimal', precision: 12, scale: 2, nullable: true })
    // DecimalTransformer is application-layer; numeric(12,2) is the SQL shape.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "areaM2" numeric(12, 2)
    `);

    // waterCapacityM3 — same shape as areaM2.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "waterCapacityM3" numeric(12, 2)
    `);

    // maxBiomassKg — same shape as areaM2.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "maxBiomassKg" numeric(12, 2)
    `);

    // establishedDate — @Column({ type: 'date', nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "establishedDate" date
    `);

    // facilities — @Column({ type: 'jsonb', nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "facilities" jsonb
    `);

    // notes — @Column({ type: 'text', nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "notes" text
    `);

    // metadata — @Column({ type: 'jsonb', nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "metadata" jsonb
    `);

    // isDeleted — @Column({ default: false }), no nullable: true → NOT NULL
    // DEFAULT false. Boolean literal is non-volatile, so PG11+ metadata-only.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "isDeleted" boolean NOT NULL DEFAULT false
    `);

    // deletedAt — @Column({ type: 'timestamptz', nullable: true })
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz
    `);

    // deletedBy — @Column('uuid', { nullable: true })
    // Explicit `uuid` per the data-expert.md trust-critical-id invariant.
    await queryRunner.query(`
      ALTER TABLE farm.sites
        ADD COLUMN IF NOT EXISTS "deletedBy" uuid
    `);

    // 3) Add the 2 missing indexes. Both use IF NOT EXISTS to satisfy R3.
    //    Per-tenant clones inherit indexes via `CREATE TABLE LIKE INCLUDING
    //    ALL` at provisioning time.

    // [tenantId, type] — entity decorator @Index(['tenantId', 'type']).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sites_tenant_type"
        ON farm.sites ("tenantId", "type")
    `);

    // isDeleted — entity column-level @Index() on isDeleted.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sites_isDeleted"
        ON farm.sites ("isDeleted")
    `);

    this.logger.log(
      'farm.sites entity-surface alignment complete: 12 columns + 2 indexes idempotently applied.',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback drops the 2 new indexes, the 12 new columns, then the enum
    // type. Order: indexes → columns → type (PG cannot drop a TYPE while a
    // column references it). All steps use IF EXISTS so a partial-rollback
    // restart picks up cleanly.
    this.logger.warn(
      'Reverting farm.sites entity-surface alignment. Test-environment only.',
    );

    await pinSearchPath(queryRunner, 'farm');

    await queryRunner.query(
      `DROP INDEX IF EXISTS farm."IDX_sites_isDeleted"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS farm."IDX_sites_tenant_type"`,
    );

    const columnsToDrop = [
      'deletedBy',
      'deletedAt',
      'isDeleted',
      'metadata',
      'notes',
      'facilities',
      'establishedDate',
      'maxBiomassKg',
      'waterCapacityM3',
      'areaM2',
      'city',
      'type',
    ];
    for (const col of columnsToDrop) {
      await queryRunner.query(
        `ALTER TABLE farm.sites DROP COLUMN IF EXISTS "${col}"`,
      );
    }

    await queryRunner.query(
      `DROP TYPE IF EXISTS farm.sites_type_enum CASCADE`,
    );
  }
}
