import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove the unwritten snapshot projection from the active namespace without
 * destroying any historical rows that may exist in an already deployed DB.
 *
 * The active inspector now reads Redis. A pre-existing table is renamed into
 * an explicitly retired archive, so it cannot masquerade as current cache
 * state and operators still retain any old observation material for review.
 */
export class RetireCacheEntriesSnapshot1802700000000 implements MigrationInterface {
  name = 'RetireCacheEntriesSnapshot1802700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('admin.cache_entries_snapshot') IS NULL THEN
          RETURN;
        END IF;

        IF to_regclass('admin.retired_cache_entries_snapshot') IS NOT NULL THEN
          RAISE EXCEPTION
            'cache snapshot retirement collision: active and retired tables both exist';
        END IF;

        ALTER TABLE "admin"."cache_entries_snapshot"
          RENAME TO "retired_cache_entries_snapshot";
        COMMENT ON TABLE "admin"."retired_cache_entries_snapshot" IS
          'RETIRED: historical cache observation projection; never current Redis authority';
      END
      $$;
    `);
  }

  public async down(): Promise<void> {
    throw new Error(
      'The retired snapshot projection cannot be restored as an active cache authority',
    );
  }
}
