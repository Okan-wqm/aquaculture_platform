import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Provenance ledger for `feeding_records` rows created by the 1806600000000
 * backfill.
 *
 * WHY THIS EXISTS
 * ---------------
 * `1806600000000-BackfillExecutionsToFeedingRecords.down()` used to delete every
 * row matching a content heuristic, which swept up live drain writes made after
 * the backfill ran — a documented data loss (FARM-CRITICAL-241). Row ownership
 * cannot be recovered from content, so it is recorded at INSERT time instead:
 * an AFTER INSERT trigger stamps each row with the PostgreSQL `xmin` of the
 * transaction that produced it, and the rollback fence deletes only rows proven
 * to be `BACKFILL_180660`. A row with no provenance is classified `UNKNOWN` and
 * is never deleted.
 *
 * WHY IT IS DECLARED HERE AT ALL
 * ------------------------------
 * No farm-service code reads or writes this table — it is populated by a
 * database trigger and read by the migration fence and the tenant-erasure
 * cleanup in db-migrate. It is declared as an entity because
 * `MODULE_SCHEMAS.tables` is the tenant fan-out clone list
 * (`libs/backend-common/src/database/schema-manager.service.ts`): a per-tenant
 * table absent from that list is never cloned into `tenant_<uuid>`, and
 * `tests/invariants/tenant-fanout-entity-parity.spec.ts` requires every entry in
 * that list to have a backing entity. Declaring it keeps the fan-out list and
 * the entity layer in agreement instead of letting the table exist only in SQL.
 *
 * The declaration grants no write path. Immutability is enforced in the
 * database: the migration REVOKEs INSERT/UPDATE/DELETE/TRUNCATE from PUBLIC and
 * from `farm_service`, leaving the service with SELECT only, and only the
 * trigger writes rows.
 *
 * No `schema:` — farm-service is tenant-scoped and this is a per-tenant table,
 * so `search_path` routes it into `tenant_<uuid>` at runtime (ADR-011).
 */
@Entity('feeding_record_provenance')
@Index(['tenantId', 'sourceExecutionId'])
export class FeedingRecordProvenance {
  /** The `feeding_records` row this provenance describes; 1:1, so it is the key. */
  @PrimaryColumn({ name: 'feeding_record_id', type: 'uuid' })
  feedingRecordId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'source_execution_id', type: 'uuid' })
  sourceExecutionId!: string;

  /**
   * `BACKFILL_180660` | `LIVE_DRAIN` | `UNKNOWN`, constrained by
   * `ck_feeding_record_provenance_origin`. `UNKNOWN` is the fail-closed
   * classification: unproven rows survive a rollback rather than being guessed at.
   */
  @Column({ name: 'origin', type: 'varchar', length: 32 })
  origin!: string;

  /**
   * The writing transaction's `xmin`, kept as text because `xid` is not a
   * portable column type and this value is compared, never arithmetic.
   */
  @Column({ name: 'source_xmin', type: 'text' })
  sourceXmin!: string;

  @Column({ name: 'content_hash', type: 'char', length: 32 })
  contentHash!: string;

  @Column({
    name: 'classified_at',
    type: 'timestamptz',
    default: () => 'clock_timestamp()',
  })
  classifiedAt!: Date;
}
