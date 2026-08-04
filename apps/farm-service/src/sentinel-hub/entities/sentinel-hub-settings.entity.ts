/**
 * Sentinel Hub Settings Entity
 *
 * Retained legacy Copernicus Data Space credential row.
 *
 * SECURITY: Secret columns (client_id / client_secret / instance_id) are
 * encrypted at rest with the canonical authenticated AES-256-GCM column
 * transformer (createEncryptedColumnTransformer). GCM provides confidentiality
 * AND integrity (auth tag) — replacing the previous bespoke unauthenticated
 * AES-256-CBC scheme that was vulnerable to ciphertext malleability and the
 * padding-oracle class. Active runtime reads never consult this table; the
 * bootstrap cutover scrubs all credential columns after verified migration.
 * @see HIGH sentinel-cbc
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

@Entity('sentinel_hub_settings')
@Index(['tenantId'], { unique: true })
export class SentinelHubSettings {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  @Column({
    name: 'client_id',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  clientId!: string | null; // AES-256-GCM encrypted at rest (transparent on read/write)

  @Column({
    name: 'client_secret',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  clientSecret!: string | null; // AES-256-GCM encrypted at rest (transparent on read/write)

  @Column({
    name: 'instance_id',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  instanceId!: string | null; // Legacy Sentinel Hub configuration instance identifier

  @Column({ name: 'is_configured', default: false })
  isConfigured!: boolean;

  @Column({ name: 'last_used', type: 'timestamptz', nullable: true })
  lastUsed!: Date;

  @Column({ name: 'usage_count', default: 0 })
  usageCount!: number;

  /**
   * Durable proof that the complete legacy bundle was accepted by the
   * config-service SSoT. These fields are persistence-only and intentionally
   * absent from GraphQL.
   */
  @Column({ name: 'config_cutover_at', type: 'timestamptz', nullable: true })
  configCutoverAt!: Date | null;

  @Column({ name: 'config_cutover_bundle_digest', type: 'varchar', length: 64, nullable: true })
  configCutoverBundleDigest!: string | null;

  @Column({ name: 'config_cutover_version', type: 'integer', nullable: true })
  configCutoverVersion!: number | null;

  @Column({
    name: 'config_cutover_source_tenant_id',
    type: 'uuid',
    nullable: true,
  })
  configCutoverSourceTenantId!: string | null;

  @Column({ name: 'config_cutover_erased_at', type: 'timestamptz', nullable: true })
  configCutoverErasedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
