import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  pinSearchPath,
} from '@aquaculture/backend-common/database';

/**
 * AlignFarmEntitySurfaceExt1789100000000
 * ============================================================================
 *
 * Closes the SchemaDriftValidator nullability drift class on `farm.sites`
 * surfaced by the bootstrap-from-scratch invariant at f22922d1: the Site
 * entity declares 6 columns NOT NULL (no `nullable: true`), but the
 * baseline created them NULLABLE — defaulted but not constrained.
 *
 * # The 6 drift columns and entity ground truth
 *
 *   - status      → enum SiteStatus, default 'active'
 *   - timezone    → varchar(50), default 'UTC'
 *   - isActive    → boolean, default true
 *   - createdAt   → @CreateDateColumn timestamptz
 *   - updatedAt   → @UpdateDateColumn timestamptz
 *   - version     → @VersionColumn integer
 *
 * # Backfill safety per type
 *
 *   - status     → 'active'
 *   - timezone   → 'UTC'
 *   - isActive   → true
 *   - createdAt  → NOW()
 *   - updatedAt  → COALESCE("createdAt", NOW())
 *   - version    → 1
 *
 * Each ALTER COLUMN SET NOT NULL is wrapped in a `DO $$ BEGIN IF EXISTS
 * (SELECT 1 FROM information_schema.columns WHERE ... is_nullable
 * = 'YES') THEN ... END IF; END $$` block — R10 idempotency.
 *
 * Closes: docs/reviews/orphan-findings.md#ORPHAN-HIGH-055
 */
export class AlignFarmEntitySurfaceExt1789100000000
  implements MigrationInterface
{
  name = 'AlignFarmEntitySurfaceExt1789100000000';

  private readonly logger = new MigrationLogger(
    'AlignFarmEntitySurfaceExt1789100000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    await pinSearchPath(queryRunner, 'farm');

    this.logger.log(
      'Tightening 6 NOT NULL constraints on farm.sites.',
    );

    // 1) status — backfill NULL → 'active', then SET NOT NULL.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'status'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "status" = 'active'
           WHERE "status" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "status" SET NOT NULL;
        END IF;
      END $$
    `);

    // 2) timezone — backfill NULL → 'UTC', then SET NOT NULL.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'timezone'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "timezone" = 'UTC'
           WHERE "timezone" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "timezone" SET NOT NULL;
        END IF;
      END $$
    `);

    // 3) isActive — backfill NULL → true, then SET NOT NULL.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'isActive'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "isActive" = true
           WHERE "isActive" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "isActive" SET NOT NULL;
        END IF;
      END $$
    `);

    // 4) createdAt — backfill NULL → NOW(), then SET NOT NULL.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'createdAt'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "createdAt" = NOW()
           WHERE "createdAt" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "createdAt" SET NOT NULL;
        END IF;
      END $$
    `);

    // 5) updatedAt — backfill NULL → COALESCE("createdAt", NOW()).
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'updatedAt'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "updatedAt" = COALESCE("createdAt", NOW())
           WHERE "updatedAt" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "updatedAt" SET NOT NULL;
        END IF;
      END $$
    `);

    // 6) version — backfill NULL → 1, then SET NOT NULL.
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'farm'
             AND table_name = 'sites'
             AND column_name = 'version'
             AND is_nullable = 'YES'
        ) THEN
          UPDATE farm.sites
             SET "version" = 1
           WHERE "version" IS NULL;
          ALTER TABLE farm.sites
            ALTER COLUMN "version" SET NOT NULL;
        END IF;
      END $$
    `);

    this.logger.log(
      'farm.sites NOT NULL alignment complete: 6 columns now match the entity surface.',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Reverting farm.sites NOT NULL tightening. Test-environment only.',
    );

    await pinSearchPath(queryRunner, 'farm');

    const columns = [
      'version',
      'updatedAt',
      'createdAt',
      'isActive',
      'timezone',
      'status',
    ];
    for (const col of columns) {
      await queryRunner.query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'farm'
               AND table_name = 'sites'
               AND column_name = '${col}'
               AND is_nullable = 'NO'
          ) THEN
            ALTER TABLE farm.sites
              ALTER COLUMN "${col}" DROP NOT NULL;
          END IF;
        END $$
      `);
    }
  }
}
