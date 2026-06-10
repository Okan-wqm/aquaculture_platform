/**
 * EdgeProvisioningRecordV2 — ceremony attestation for device activation.
 *
 * Per ADR-034. Per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.provisioning_records`. Each row records a single ceremony:
 * device activation moment, witness identities, fingerprint hash chain.
 * Witnesses live in the sibling `witnesses` junction table.
 *
 * # DDL contract (ADR-022 §2 carried forward)
 *
 *   - `fingerprintSha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - `bundleSha256 bytea NOT NULL CHECK (octet_length=32)` — copy of
 *     the provisioning bundle hash; redundant with device row but kept
 *     here so the ceremony attestation is self-contained.
 *   - FK `deviceId → devices.device_id` ON DELETE RESTRICT.
 *   - Immutability: rows are append-only; corrections issue a new
 *     ceremony row with a `supersedes` back-reference (no UPDATE/DELETE).
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('provisioning_records')
@Index(['tenantId', 'deviceId', 'ceremonyAt'], { unique: true })
@Index(['tenantId', 'ceremonyType'])
export class EdgeProvisioningRecordV2 {
  @PrimaryGeneratedColumn('uuid', { name: 'provisioning_id' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Column({ name: 'ceremony_type', type: 'varchar', length: 32 })
  ceremonyType!: string;

  @Column({ name: 'ceremony_at', type: 'timestamptz' })
  ceremonyAt!: Date;

  @Column({ name: 'fingerprint_sha256', type: 'bytea' })
  fingerprintSha256!: Buffer;

  @Column({ name: 'bundle_sha256', type: 'bytea' })
  bundleSha256!: Buffer;

  @Column({ name: 'supersedes_provisioning_id', type: 'uuid', nullable: true })
  supersedesProvisioningId?: string;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes?: string;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
