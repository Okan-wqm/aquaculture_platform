/**
 * EdgeDeviceV2 — v2 device row, per-tenant (sensor schema).
 *
 * Per ADR-034, this entity supersedes ADR-022's `edge.devices` placement.
 * Lives under sensor source schema (search_path routes to `tenant_<uuid>`
 * at runtime). v1 `EdgeDevice` (apps/sensor-service/src/edge-device/
 * entities/edge-device.entity.ts) remains during the dual-write cutover
 * window; Faz 3 baseline migration consolidates both into a single
 * coherent shape.
 *
 * # v1/v2 coexistence contract (ADR-034 §Coexistence, DB-SENSOR-MEDIUM-003)
 *
 * Disclosed WIP mid-cutover — BOTH models are intentionally registered in
 * edge-device.module.ts:
 *
 *   - v1 `edge_devices` (`EdgeDevice`) is the PRODUCTION-ACTIVE model:
 *     every runtime write path (edge-device.service.ts,
 *     provisioning.service.ts, mqtt-auth.service.ts) and the GraphQL
 *     surface (edge-device.resolver.ts) operate on v1 today.
 *   - the v2 family (`devices`/`policies`/`licenses`/`firmware_releases`/
 *     `provisioning_records`/`witnesses`/`audit_archive_v1`) is the
 *     ADR-034 TARGET model: migration-created, drift-validated, and
 *     module-registered so schema fan-out and SchemaDriftValidator cover
 *     it, but it has NO runtime write path yet.
 *   - Single-writer-per-model rule: one service file must never write both
 *     the v1 and the v2 device row — the cutover is a routing flip, not an
 *     interleaved dual-write scattered across handlers. Enforced by
 *     tests/invariants/edge-device-dual-model-guard.spec.ts.
 *   - Do NOT retire v1 outside the planned cutover
 *     (docs/plans/2026-05-12-sens-api-gateway-edge-platform-v2-revision.md).
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
 *     is installed by `SensorV2TenantFkAndLicenseGrant1800300000000`
 *     as `NOT VALID` for safe adoption on existing tenant data.
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
