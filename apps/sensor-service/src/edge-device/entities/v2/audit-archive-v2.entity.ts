/**
 * EdgeAuditArchiveV2 — long-term audit chain archive (per-tenant).
 *
 * Per ADR-025. Per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.audit_archive_v1` (the partitioning model carries forward, now
 * scoped per-tenant). The Rust agent emits audit events; sensor-service
 * verifies the device's audit attestation pubkey and persists rows
 * here append-only.
 *
 * # DDL contract (ADR-022 §2.6 carried forward, per-tenant variant)
 *
 *   - `chainHash bytea NOT NULL CHECK (octet_length=32)` — running hash
 *     over (previousChainHash || eventPayloadHash). Verifiable end-to-
 *     end without replay.
 *   - `prevChainHash bytea NULL` (genesis row carries NULL).
 *   - `PARTITION BY RANGE (migrated_at)` — monthly partitions per tenant.
 *     Composite PK `(migrated_at, archive_id)` carries the partition
 *     key so the planner prunes efficiently.
 *   - pg_partman ownership: baseline migration enables the partition
 *     manager schedule per-tenant.
 *   - FK `deviceId → devices.device_id` ON DELETE RESTRICT.
 *   - Append-only: BEFORE UPDATE / BEFORE DELETE triggers refuse any
 *     mutation; chain integrity ALSO checks at SELECT time via a
 *     verifier view (deferred to Faz 7 runbook).
 *
 * # Per-tenant partition cost
 *
 * ADR-025 §"Consequences/Negative" tracks `audit_archive_v1` partition
 * count under per-tenant scaling as OPEN-ADR-025-1. Monitor partition
 * count in Faz 8; global event_store fallback is the migration target
 * if partition pressure exceeds 50k.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

@Entity('audit_archive_v1')
@Index(['tenantId', 'deviceId', 'migratedAt'])
@Index(['tenantId', 'chainHash'])
export class EdgeAuditArchiveV2 {
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @PrimaryColumn({ name: 'migrated_at', type: 'timestamptz' })
  migratedAt!: Date;

  @PrimaryColumn({ name: 'archive_id', type: 'uuid' })
  archiveId!: string;

  @Column({ name: 'device_id', type: 'uuid', nullable: true })
  deviceId?: string;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: string;

  @Column({ name: 'event_payload', type: 'jsonb' })
  eventPayload!: Record<string, unknown>;

  @Column({ name: 'event_payload_hash', type: 'bytea' })
  eventPayloadHash!: Buffer;

  @Column({ name: 'chain_hash', type: 'bytea' })
  chainHash!: Buffer;

  @Column({ name: 'prev_chain_hash', type: 'bytea', nullable: true })
  prevChainHash?: Buffer;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
