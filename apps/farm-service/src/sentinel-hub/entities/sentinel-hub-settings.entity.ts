/**
 * Sentinel Hub Settings Entity
 *
 * Her tenant için Copernicus Data Space kimlik bilgilerini saklar.
 *
 * SECURITY: Secret columns (client_id / client_secret / instance_id) are
 * encrypted at rest with the canonical authenticated AES-256-GCM column
 * transformer (createEncryptedColumnTransformer). GCM provides confidentiality
 * AND integrity (auth tag) — replacing the previous bespoke unauthenticated
 * AES-256-CBC scheme that was vulnerable to ciphertext malleability and the
 * padding-oracle class. The ORM encrypts on write and decrypts on read, so
 * the service layer never touches ciphertext.
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
import { ObjectType, Field, ID, Int, HideField } from '@nestjs/graphql';
import { createEncryptedColumnTransformer } from '@aquaculture/backend-common/security';

@ObjectType()
@Entity('sentinel_hub_settings')
@Index(['tenantId'], { unique: true })
export class SentinelHubSettings {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  @Column({
    name: 'client_id',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  clientId!: string; // AES-256-GCM encrypted at rest (transparent on read/write)

  @Column({
    name: 'client_secret',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  clientSecret!: string; // AES-256-GCM encrypted at rest (transparent on read/write)

  @Column({
    name: 'instance_id',
    type: 'text',
    nullable: true,
    transformer: createEncryptedColumnTransformer('SENTINEL_HUB_ENCRYPTION_KEY'),
  })
  instanceId!: string; // AES-256-GCM encrypted at rest - WMTS Configuration Instance ID

  @Field()
  @Column({ name: 'is_configured', default: false })
  isConfigured!: boolean;

  @Field({ nullable: true })
  @Column({ name: 'last_used', type: 'timestamptz', nullable: true })
  lastUsed!: Date;

  @Field(() => Int)
  @Column({ name: 'usage_count', default: 0 })
  usageCount!: number;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * GraphQL Output Types
 */

@ObjectType()
export class SentinelHubStatus {
  @Field()
  isConfigured!: boolean;

  @Field({ nullable: true })
  clientIdMasked?: string;

  @Field({ nullable: true })
  instanceIdMasked?: string;

  @Field({ nullable: true })
  lastUsed?: Date;

  @Field(() => Int)
  usageCount!: number;
}

@ObjectType()
export class SentinelHubCredentials {
  @Field()
  clientId!: string;

  @Field({ nullable: true })
  instanceId?: string;

  @Field()
  hasClientSecret!: boolean;

  @Field({ description: 'Indicates credentials are configured and valid' })
  isConfigured!: boolean;
}

/**
 * SEC-C14: SentinelHubToken — accessToken is hidden from GraphQL schema.
 *
 * The accessToken field is intentionally excluded from the GraphQL response
 * via @HideField(). All Sentinel Hub API calls are now proxied through the
 * backend (see SentinelHubProxyController), so the frontend never needs
 * direct access to OAuth tokens.
 *
 * This eliminates the XSS token exfiltration attack surface: even if an
 * attacker achieves XSS, there is no token in the browser to steal.
 */
@ObjectType()
export class SentinelHubToken {
  @HideField()
  accessToken!: string;

  @Field(() => Int)
  expiresIn!: number;
}

/**
 * SEC-C14: SentinelHubWmtsConfig — accessToken is hidden from GraphQL schema.
 *
 * Same rationale as SentinelHubToken above. The instanceId remains visible
 * because it is not a secret — it identifies the WMTS configuration but
 * cannot be used without an OAuth token.
 */
@ObjectType()
export class SentinelHubWmtsConfig {
  @Field()
  instanceId!: string;

  @HideField()
  accessToken!: string;

  @Field(() => Int)
  expiresIn!: number;
}
