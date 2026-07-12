import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddWorkOrderEffectiveCostDateIndex — index the MAINTENANCE derived-cost
 * date expression.
 *
 * The finance ledger projects MAINTENANCE cost from work_orders filtered by
 * `COALESCE("completedAt","createdAt") BETWEEN from AND to`. work_orders has
 * a `(tenantId, dueDate)` index but nothing covering that COALESCE, so every
 * finance summary did a full per-tenant work_orders scan (PERF-MEDIUM). This
 * adds an expression index on `(tenantId, COALESCE(completedAt, createdAt))`
 * so the range scan is index-driven; the feeding/harvest/health source
 * tables already carry their `(tenantId, dateColumn)` indexes.
 *
 * Blue-green safe: additive index (no data change), idempotent, replay-safe.
 * A short lock/statement timeout bounds the DDL so a deploy fails fast rather
 * than blocking writes if the exclusive lock can't be acquired quickly.
 */
export class AddWorkOrderEffectiveCostDateIndex1805400000000
  implements MigrationInterface
{
  name = 'AddWorkOrderEffectiveCostDateIndex1805400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '2s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '60s'`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_work_orders_tenant_effective_cost_date"
         ON "work_orders" ("tenantId", (COALESCE("completedAt", "createdAt")))`,
    );
  }

  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    const rows = (await queryRunner.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_work_orders_tenant_effective_cost_date'
      ) AS ok
    `)) as Array<{ ok: boolean }>;
    return rows[0]?.ok === true;
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "idx_work_orders_tenant_effective_cost_date"`,
    );
  }
}
