/**
 * EdgeFirmwareReleaseV2 — versioned firmware artifact + SBOM metadata.
 *
 * Per ADR-025. Per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.firmware_releases`. Operators stage firmware artifacts in
 * `MinIO` or similar object storage; this entity records the manifest
 * (sha256 of the artifact + SBOM hash + signing key epoch).
 *
 * # DDL contract (ADR-022 §2 carried forward)
 *
 *   - `artifactSha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - `sbomSha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - `firmwareSigningEpoch smallint NOT NULL` — must match the
 *     epoch on the device row when the device pulls the artifact;
 *     mismatch is a CRITICAL signal.
 *   - FK `tenantId → auth.tenants` ON DELETE RESTRICT.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('firmware_releases')
@Index(['tenantId', 'hardwareModel', 'version'], { unique: true })
@Index(['tenantId', 'releasedAt'])
export class EdgeFirmwareReleaseV2 {
  @PrimaryGeneratedColumn('uuid', { name: 'release_id' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'hardware_model', type: 'varchar', length: 64 })
  hardwareModel!: string;

  @Column({ name: 'version', type: 'varchar', length: 32 })
  version!: string;

  @Column({ name: 'artifact_sha256', type: 'bytea' })
  artifactSha256!: Buffer;

  @Column({ name: 'sbom_sha256', type: 'bytea' })
  sbomSha256!: Buffer;

  @Column({ name: 'artifact_uri', type: 'text' })
  artifactUri!: string;

  @Column({ name: 'firmware_signing_epoch', type: 'smallint' })
  firmwareSigningEpoch!: number;

  @Column({ name: 'release_notes', type: 'text', nullable: true })
  releaseNotes?: string;

  @Column({ name: 'released_at', type: 'timestamptz' })
  releasedAt!: Date;

  @Column({ name: 'released_by', type: 'uuid' })
  releasedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
