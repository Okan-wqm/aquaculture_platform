import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

import type { HoldScope } from './legal-hold.types';

/**
 * Canonical legal-hold registry row.
 *
 * # Schema location
 *
 * Lives in the new `compliance` schema (NOT `shared` — adding a 5th
 * shared table requires an ADR per ADR-011 + W5 BLOCKER-15). The
 * `compliance` schema is reserved for cross-cutting compliance state
 * (legal holds today; future: retention policies, GDPR request rows
 * if their schemas converge).
 *
 * # Indexes
 *
 *   - Composite index (tenantId, scope, resourceId, releasedAt):
 *     all hot-path queries are "is there an active hold for this
 *     (tenant, scope, resource)?" — tenant-leading composite is the
 *     correct shape; releasedAt-suffix lets the partial index trim
 *     released rows from the lookup.
 *   - Partial unique on (tenantId, scope, resourceId) WHERE releasedAt
 *     IS NULL: prevents duplicate active holds on the same
 *     (tenant, scope, resource) tuple. Multiple HISTORICAL holds on
 *     the same resource ARE permitted (legitimate — a hold from one
 *     legal matter can be released and a new hold for a different
 *     matter applied later).
 *   - Index on legalMatterId: legal teams query "all holds for matter
 *     X" when a matter closes — fast lookup needed.
 *
 * Closes: foundation for LEGAL-CRITICAL-001..003 + LEGAL-HIGH-002..006.
 */
@Entity('legal_holds', { schema: 'compliance' })
@Index('IDX_legal_hold_active', ['tenantId', 'scope', 'resourceId', 'releasedAt'])
@Index('IDX_legal_hold_legal_matter', ['legalMatterId'])
@Index('UQ_legal_hold_active_per_resource', ['tenantId', 'scope', 'resourceId'], {
  unique: true,
  where: '"releasedAt" IS NULL',
})
export class LegalHoldEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  tenantId!: string;

  /**
   * Hold scope discriminator. Closed enum — see HoldScope in
   * legal-hold.types.ts.
   *
   * WHY enum (not free-form string): adding a new scope value MUST be
   * accompanied by audit of every destructive op for that scope class.
   * Closing the enum makes that audit a refactor signal at compile time.
   */
  @Column({ type: 'varchar', length: 32 })
  scope!: HoldScope;

  /**
   * Resource identifier within the scope. Null for tenant-wide holds
   * (scope='tenant'). Validation invariant (not enforced at DB level —
   * service-level): non-null for sub-tenant scopes.
   */
  @Column({ type: 'uuid', nullable: true })
  resourceId!: string | null;

  /**
   * Free-text reason. Captured at hold-application time for audit.
   */
  @Column({ type: 'text' })
  reason!: string;

  /**
   * Reference to the legal matter / regulatory request that prompted
   * the hold. MANDATORY for GDPR proportionality — a hold without a
   * matter reference is a blanket freeze that violates data-protection
   * regulations (mirrors messaging-service's MSG-CRITICAL-018 invariant).
   */
  @Column({ type: 'varchar', length: 128 })
  legalMatterId!: string;

  /**
   * User identifier (auth.users.id) of the operator who applied the hold.
   */
  @Column({ type: 'uuid' })
  appliedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  appliedAt!: Date;

  /**
   * User identifier of the operator who released the hold. Null while
   * the hold is active. Releasing a hold is a DUAL-CONTROL operation
   * (LEGAL-MEDIUM-002) — the second approver writes here AFTER the
   * compliance.legal_hold_release_approvals row is in place.
   */
  @Column({ type: 'uuid', nullable: true })
  releasedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  releasedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  releaseReason!: string | null;
}
