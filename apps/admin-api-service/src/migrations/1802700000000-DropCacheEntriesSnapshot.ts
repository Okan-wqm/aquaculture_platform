import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DropCacheEntriesSnapshot — remove the table the cache inspector pretended to
 * read.
 *
 * `admin.cache_entries_snapshot` had exactly one writer: `POST
 * /debug/cache/capture`, an endpoint nothing in this repository has ever
 * called. No middleware, no interceptor, no service, no edge agent. The table
 * was therefore structurally empty, and a daily cron deleted rows older than a
 * week from it, so the "cache inspector" listed an empty set while Redis — the
 * cache that actually exists — sat one constructor injection away.
 *
 * The emptiness is what kept the defect invisible: the page rendered "No cache
 * entries found" and looked correct, so nobody noticed that the invalidation
 * buttons beside it were logging stubs returning a hard-coded 0.
 *
 * `CacheInspectorService` now reads and clears Redis directly, so nothing
 * references this table.
 *
 * # SAFETY SHAPE
 *   * DROP of a table with no writer and no reader. There is no data to
 *     preserve — not "little", none: every row would have had to arrive through
 *     a route no caller invokes.
 *   * `IF EXISTS` so a replay is a no-op.
 *   * `down()` recreates the shape for rollback completeness. It cannot restore
 *     rows, and there were none.
 */
export class DropCacheEntriesSnapshot1802700000000 implements MigrationInterface {
  name = 'DropCacheEntriesSnapshot1802700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "admin"."cache_entries_snapshot"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "admin"."cache_entries_snapshot" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "debugSessionId" uuid NULL,
        "tenantId" uuid NULL,
        "key" character varying(500) NOT NULL,
        "value" jsonb NULL,
        "sizeBytes" integer NULL,
        "ttlSeconds" integer NULL,
        "expiresAt" TIMESTAMP NULL,
        "hitCount" integer NOT NULL DEFAULT 0,
        "lastAccessedAt" TIMESTAMP NULL,
        "cacheStore" character varying(100) NULL,
        "tags" jsonb NULL,
        "capturedAt" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cache_entries_snapshot" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cache_entries_snapshot_session" ON "admin"."cache_entries_snapshot" ("debugSessionId", "capturedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_cache_entries_snapshot_tenant_key" ON "admin"."cache_entries_snapshot" ("tenantId", "key")`,
    );
  }
}
