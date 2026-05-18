/**
 * EdgeLicenseV2 — compact Ed25519 JWS license issued by billing-service.
 *
 * Per ADR-025. Per-tenant under sensor schema. Supersedes ADR-022's
 * `edge.licenses`. billing-service is the WRITER (compact Ed25519 JWS
 * minting); sensor-service is the CONSUMER (cache + verify by the Rust
 * edge agent). Cross-service write is the only place where a non-sensor
 * role writes to a sensor-schema table — granted by per-table GRANT
 * INSERT,UPDATE on `licenses` to `billing_service` in the baseline
 * migration.
 *
 * # DDL contract (ADR-022 §2.3 carried forward)
 *
 *   - `licenseSha256 bytea NOT NULL CHECK (octet_length=32)`
 *   - EXCLUDE USING gist (tenant_id WITH =, tstzrange(issued_at,
 *     expires_at, '[]') WITH &&) — temporal overlap forbidden. Requires
 *     CREATE EXTENSION btree_gist (carried in Faz 1.10 init scripts).
 *   - FK `deviceId → devices.device_id` ON DELETE RESTRICT.
 *   - Append-only after issued; revocation flips `revoked_at` only.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('licenses')
@Index(['tenantId', 'deviceId', 'licenseSha256'], { unique: true })
@Index(['tenantId', 'deviceId', 'expiresAt'])
export class EdgeLicenseV2 {
  @PrimaryGeneratedColumn('uuid', { name: 'license_id' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'device_id', type: 'uuid' })
  deviceId!: string;

  @Column({ name: 'license_jwt', type: 'text' })
  licenseJwt!: string;

  @Column({ name: 'license_sha256', type: 'bytea' })
  licenseSha256!: Buffer;

  @Column({ name: 'plan_tier', type: 'varchar', length: 32 })
  planTier!: string;

  @Column({ name: 'issued_at', type: 'timestamptz' })
  issuedAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date;

  @Column({ name: 'revocation_reason', type: 'varchar', length: 200, nullable: true })
  revocationReason?: string;

  @Column({ name: 'issued_by', type: 'uuid' })
  issuedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
