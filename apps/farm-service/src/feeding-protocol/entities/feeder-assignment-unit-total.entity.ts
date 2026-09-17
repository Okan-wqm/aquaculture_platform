/**
 * FeederAssignmentUnitTotal — "bir ünitenin aktif payları toplamı" değişmezinin
 * VERİTABANI TARAFINDAKİ taşıyıcısı.
 *
 * WHAT: exactly one row per (tenantId, unitId) that has ever had a feeder
 * assigned. `activeSharePercentTotal` is maintained ONLY by the commit-time
 * constraint trigger on `feeder_assignments`, and the table carries a CHECK
 * constraint that admits just two values: 0 (the unit currently has no active
 * feeder — hand-fed) or 100 (its feeders cover the whole daily dose).
 *
 * WHY a separate row instead of a service-layer sum:
 *  1. The invariant becomes a plain CHECK constraint. A sum cannot be expressed
 *     in a CHECK over the assignment table itself, but it CAN be expressed as a
 *     CHECK over a derived total — so the only committed state the schema admits
 *     is "no feeders" or "feeders covering 100%". No writer bypasses it: raw SQL,
 *     a future service, a data-fix script and the ORM all hit the same wall.
 *  2. It is the serialization anchor. Every mutation of a unit's feeder set
 *     UPDATEs this one row, so two transactions touching the same unit conflict
 *     at the row level: under READ COMMITTED the second blocks and then re-reads
 *     the committed set, under REPEATABLE READ / SERIALIZABLE it aborts with a
 *     serialization failure. Without the anchor, two concurrent inserts could
 *     each observe a valid sum and commit a unit at 150%.
 *
 * A unit that never had a feeder simply has no row here; "no row" and "row with
 * total 0" both mean the unit is hand-fed. The row is never deleted once created
 * — keeping it is what preserves the anchor for later edits.
 *
 * @module FeedingProtocol/Entities
 */
import { Entity, Column, PrimaryColumn, UpdateDateColumn, Index } from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

/**
 * NOTE: deliberately NOT a GraphQL @ObjectType. This row is the constraint's
 * own bookkeeping, derived entirely from `feeder_assignments`. Publishing it
 * would invite clients to read a total they can compute from the assignments
 * they already fetch, and to treat a database-internal anchor as a domain
 * concept. `unitFeederAssignments` is the API for "which feeders, what shares".
 */
@Entity('feeder_assignment_unit_totals')
@Index(['tenantId'])
export class FeederAssignmentUnitTotal {
  @PrimaryColumn('uuid')
  tenantId!: string;

  @PrimaryColumn('uuid')
  unitId!: string;

  /**
   * Ünitenin AKTİF atamalarının pay toplamı. CHECK yalnız 0 veya 100'e izin
   * verir; trigger bu kolonu her yazışta yeniden hesaplar.
   */
  @Column({ type: 'numeric', precision: 6, scale: 3, transformer: new DecimalTransformer() })
  activeSharePercentTotal!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
