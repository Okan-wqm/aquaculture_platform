import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * EmergencyOverrideEntity — R16 audit-trail for SCHEMA_DRIFT_FATAL
 * bypass + similar operational safeguard overrides.
 * ============================================================================
 *
 * Replaces the plan-v2 pattern of "ssh droplet; vi .env; restart service"
 * — which had no audit trail + no TTL + no reason capture — with a
 * durable, auto-expiring override record. Operators invoke aqua-ctl:
 *
 *   aqua-ctl drift-bypass --service hr --reason "INC-123" --ttl 2h
 *
 * aqua-ctl writes one row here. The drift validator + related gates
 * consult the table at startup / runtime (wiring lands in a follow-up
 * phase). Every bypass is:
 *   - time-bounded via expires_at
 *   - justified via reason
 *   - attributable via actor (GitHub handle or service identity)
 *   - retention-safe for SOC2 CC6.1 (7-year retention per ADR-024)
 *
 * # Why observability schema, not the service's own schema
 *
 * The override targets a specific service, but it's cross-cutting ops
 * data. Keeping it in `observability` means (a) one query to surface
 * all active bypasses platform-wide and (b) the record survives the
 * target service's full schema lifecycle (even if hr_service schema
 * is destructively re-provisioned, the audit of who bypassed when
 * persists).
 */
@Entity('emergency_overrides', { schema: 'observability' })
@Index('IDX_emergency_overrides_service_active', [
  'serviceName',
  'expiresAt',
])
@Index('IDX_emergency_overrides_actor', ['actor', 'createdAt'])
export class EmergencyOverrideEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Target service slug. Lowercase — matches serviceName used by
   * MigrationRunnerService / SchemaDriftValidator (e.g. 'hr', 'farm').
   */
  @Column({ type: 'varchar', length: 64, name: 'service_name' })
  serviceName!: string;

  @Column({
    type: 'enum',
    enum: ['drift_fatal_bypass', 'migration_skip', 'validator_disable'],
    enumName: 'emergency_override_kind_enum',
    name: 'kind',
  })
  kind!: 'drift_fatal_bypass' | 'migration_skip' | 'validator_disable';

  /** Freeform justification — REQUIRED. Ticket ref, incident ID, etc. */
  @Column({ type: 'text' })
  reason!: string;

  /**
   * Who issued the override. Populated by aqua-ctl from the shell's
   * `$GITHUB_USER` or `$SUDO_USER` env var; falls back to the OS user
   * if neither is set. Never anonymous — CLI refuses to write without
   * a valid actor string.
   */
  @Column({ type: 'varchar', length: 128 })
  actor!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  /**
   * Hard expiry — after this moment the override MUST NOT suppress
   * anything. Consumers read `WHERE expires_at > NOW()`. Never NULL —
   * there is no such thing as a permanent bypass.
   */
  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  /** Environment scope. 'production' / 'staging' / 'development'. */
  @Column({ type: 'varchar', length: 32 })
  environment!: string;

  /**
   * Optional revocation pointer — when an override is explicitly
   * revoked before natural expiry, the revoker populates this with
   * the revocation justification + the row is effectively inert.
   * We keep the row (append-only audit trail) rather than DELETE.
   */
  @Column({ type: 'text', name: 'revoked_reason', nullable: true })
  revokedReason!: string | null;

  @Column({ type: 'timestamptz', name: 'revoked_at', nullable: true })
  revokedAt!: Date | null;
}
