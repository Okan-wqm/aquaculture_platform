/**
 * EdgeDeviceV2 — v2 device row, per-tenant (sensor schema).
 *
 * Per ADR-025, this entity supersedes ADR-022's `edge.devices` placement.
 * Lives under sensor source schema (search_path routes to `tenant_<uuid>`
 * at runtime). v1 `EdgeDevice` (apps/sensor-service/src/edge-device/
 * entities/edge-device.entity.ts) remains during the dual-write cutover
 * window; Faz 3 baseline migration consolidates both into a single
 * coherent shape.
 *
 * # DDL contract (constraint set carried verbatim from ADR-022 §2.1)
 *
 *   - `trustBundleSha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - `provisioningBlobSha256 bytea NULL` (32-byte hash, optional)
 *   - `deviceAuditAttestationPubkey bytea NULL` (32-byte Ed25519 pubkey)
 *   - `firmwareSigningEpoch smallint NOT NULL DEFAULT 1`
 *   - `hardwareModel varchar(64) CHECK (hardware_model IN (...))`
 *     (allowlist enforced in baseline migration; entity declares the
 *     column shape only)
 *   - FK `tenantId → auth.tenants` ON DELETE RESTRICT ON UPDATE RESTRICT
 *   - FK `createdBy / updatedBy → auth.users` ON DELETE RESTRICT
 *   - RLS: tenant_isolation_policy via Faz 1.7 canonical predicate
 *   - immutability: append-only audit attestation rows live in
 *     `audit_archive_v1` (sibling entity), not here.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('devices')
@Index(['tenantId', 'lifecycleState', 'provisioningState'])
@Index(['tenantId', 'hardwareModel'])
@Index(['tenantId', 'deviceCode'], { unique: true })
export class EdgeDeviceV2 {
  @PrimaryGeneratedColumn('uuid', { name: 'device_id' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'device_code', type: 'varchar', length: 64 })
  deviceCode!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 200, nullable: true })
  displayName?: string;

  @Column({ name: 'hardware_model', type: 'varchar', length: 64 })
  hardwareModel!: string;

  @Column({ name: 'lifecycle_state', type: 'varchar', length: 32, default: 'provisioned' })
  lifecycleState!: string;

  @Column({ name: 'provisioning_state', type: 'varchar', length: 32, default: 'pending' })
  provisioningState!: string;

  @Column({ name: 'trust_bundle_sha256', type: 'bytea' })
  trustBundleSha256!: Buffer;

  @Column({ name: 'provisioning_blob_sha256', type: 'bytea', nullable: true })
  provisioningBlobSha256?: Buffer;

  @Column({ name: 'device_audit_attestation_pubkey', type: 'bytea', nullable: true })
  deviceAuditAttestationPubkey?: Buffer;

  @Column({ name: 'firmware_signing_epoch', type: 'smallint', default: 1 })
  firmwareSigningEpoch!: number;

  @Column({ name: 'provisioned_at', type: 'timestamptz', nullable: true })
  provisionedAt?: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date;

  @Column({ name: 'created_by', type: 'uuid' })
  createdBy!: string;

  @Column({ name: 'updated_by', type: 'uuid' })
  updatedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn({ name: 'version', default: 1 })
  version!: number;
}
