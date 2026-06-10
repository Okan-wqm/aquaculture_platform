/**
 * EdgePolicyV2 — versioned RBAC/ABAC policy bundle for an edge device.
 *
 * Per ADR-034 — per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.policies`. The monotonic `policyVersion` is enforced at write
 * time by sensor-service; replay protection lives in the Rust agent's
 * `manifest_version_store.rs` SQLCipher floor.
 *
 * # DDL contract (ADR-022 §2.2 carried forward)
 *
 *   - `policySha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - `isCurrent boolean NOT NULL DEFAULT false` + trigger ensures at
 *     most one row per (tenant_id, device_id) carries isCurrent=true;
 *     partial unique index on (tenant_id, device_id) WHERE is_current.
 *   - INCLUDE covering index for hot-path lookups by device_id.
 *   - FK `deviceId → devices.device_id` ON DELETE RESTRICT.
 *   - Immutability: once is_current flips false the row is read-only
 *     (BEFORE UPDATE trigger refuses non-is_current edits).
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('policies')
@Index(['tenantId', 'deviceId', 'policyVersion'], { unique: true })
@Index(['tenantId', 'deviceId', 'isCurrent'])
export class EdgePolicyV2 {
  @PrimaryGeneratedColumn('uuid', { name: 'policy_id' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Column({ name: 'policy_version', type: 'integer' })
  policyVersion!: number;

  @Column({ name: 'policy_sha256', type: 'bytea' })
  policySha256!: Buffer;

  @Column({ name: 'policy_jws', type: 'text' })
  policyJws!: string;

  @Column({ name: 'is_current', type: 'boolean', default: false })
  isCurrent!: boolean;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
