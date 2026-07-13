import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Per-tenant Data Encryption Key (DEK) store for event-store crypto-shred
 * (DB-INFRA-HIGH-003, Part B — see docs/plans/2026-07-12-event-store-crypto-shred-design.md).
 *
 * Envelope encryption: the raw DEK is stored WRAPPED — AES-256-GCM-encrypted by
 * the master KEK (env/secret store, never persisted). On GDPR erasure the DEK is
 * destroyed (`wrapped_dek` overwritten + `shredded_at` set); every `stored_events`
 * payload encrypted under it becomes permanently unrecoverable, while the
 * immutable event envelope survives for replay integrity.
 *
 * Cross-tenant infrastructure table in `event_store` (registered in
 * MODULE_SCHEMAS['event_store'].infrastructureTables); NOT per-tenant cloned.
 */
@Entity('tenant_payload_keys', { schema: 'event_store' })
export class TenantPayloadKey {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  /** `enc:<v>:<iv>:<tag>:<ct>` of the 32-byte DEK, wrapped by the KEK. */
  @Column({ type: 'text', name: 'wrapped_dek' })
  wrappedDek!: string;

  @Column({ type: 'smallint', name: 'key_version', default: 1 })
  keyVersion!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  /** Set when the DEK has been destroyed on erasure — the tenant's data is crypto-shredded. */
  @Column({ type: 'timestamptz', name: 'shredded_at', nullable: true })
  shreddedAt?: Date | null;
}
