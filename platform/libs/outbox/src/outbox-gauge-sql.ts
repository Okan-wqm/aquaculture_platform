/**
 * The queue gauges (`outbox_pending`, `outbox_dead_letter_count`,
 * `outbox_oldest_pending_age_seconds`) in ONE statement.
 *
 * The outbox table keeps published rows for days, so every count here must be
 * served by a partial index instead of a scan of that history. Postgres uses a
 * partial index only when the query's WHERE implies the index predicate, which
 * is why each sub-select spells the `"isDeadLettered"` literal exactly as the
 * index does and never binds it as a parameter:
 *
 *   - pending / oldest pending → the poll index
 *     (`WHERE "publishedAt" IS NULL AND "isDeadLettered" = false`), created by
 *     `buildTransactionalOutboxUpSql`;
 *   - dead letters → its `= true` twin, created by
 *     `buildOutboxDeadLetterIndexUpSql`.
 *
 * `outbox-migration.spec.ts` pins these spellings together. `$1` is
 * `OUTBOX_MAX_RETRIES`.
 */
export function buildOutboxGaugeSql(tableName: string): string {
  return `SELECT
           (SELECT COUNT(*) FROM "${tableName}"
             WHERE "publishedAt" IS NULL AND "isDeadLettered" = false AND "retryCount" < $1) AS pending,
           (SELECT COUNT(*) FROM "${tableName}"
             WHERE "publishedAt" IS NULL AND "isDeadLettered" = true) AS dead_lettered,
           (SELECT EXTRACT(EPOCH FROM (NOW() - MIN("createdAt"))) FROM "${tableName}"
             WHERE "publishedAt" IS NULL AND "isDeadLettered" = false) AS age_seconds`;
}
