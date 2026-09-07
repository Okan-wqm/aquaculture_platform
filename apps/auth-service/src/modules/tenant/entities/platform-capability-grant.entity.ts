import type { PlatformCapability } from '@platform/event-contracts';
import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * PlatformCapabilityGrant (ADR-0016, SEC-HIGH-059)
 *
 * WHY: one bit — the SUPER_ADMIN role — used to govern every mutation on the
 * platform-admin surface. A grant row narrows that bit to a named capability
 * (`billing-ops`, `support-ops`, `security-ops`, `platform-read-only`,
 * `break-glass`). TokenService projects a user's LIVE grants into the
 * `platformCapabilities` JWT claim at every mint; the kernel
 * `PlatformCapabilityGuard` reads the claim; nothing reads this table on the
 * request path.
 *
 * WHAT: a cross-tenant `auth`-schema table (SUPER_ADMIN has no tenant), so it
 * DECLARES `schema: 'auth'` per ADR-011. Rows are never deleted: a revoke sets
 * `revokedBy` / `revokedAt`, so the table is also the grant history an
 * auditor reads. A user holds at most one live row per capability — the
 * partial unique index `UQ_platform_capability_grants_live` (in the migration;
 * TypeORM cannot express a partial index in a decorator) is the database's
 * word on that.
 *
 * `break-glass` rows are time-boxed (`expiresAt` ≤ 4 h) and dual-controlled
 * (`grantedBy` ≠ `userId`); {@link PlatformCapabilityService} is the single
 * writer that enforces both.
 */
@Entity('platform_capability_grants', { schema: 'auth' })
@Index('IDX_platform_capability_grants_user', ['userId'])
export class PlatformCapabilityGrant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The SUPER_ADMIN the capability is granted to (auth.users.id). */
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 32 })
  capability!: PlatformCapability;

  /** The SUPER_ADMIN who granted it; equal to userId only for the bootstrap seed. */
  @Column({ type: 'uuid' })
  grantedBy!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  grantedAt!: Date;

  /** NULL = standing grant. Mandatory for `break-glass`. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  /** Ticket or incident reference — why the grant exists. */
  @Column({ type: 'varchar', length: 512 })
  reason!: string;
}

/**
 * The one definition of "live": not revoked and not expired. Used by the
 * writer (duplicate check) and by TokenService (claim projection) so the
 * claim can never disagree with the grant table.
 */
export const LIVE_PLATFORM_CAPABILITY_GRANT_SQL =
  '"revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now())';
