/**
 * Sentinel Hub Settings Entity
 *
 * Her tenant için Copernicus Data Space kimlik bilgilerini saklar.
 * Bilgiler AES-256-CBC ile şifrelenir.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

@ObjectType()
@Entity('sentinel_hub_settings')
@Index(['tenantId'], { unique: true })
export class SentinelHubSettings {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  tenantId: string;

  @Column({ name: 'client_id', type: 'text', nullable: true })
  clientId: string; // Encrypted

  @Column({ name: 'client_secret', type: 'text', nullable: true })
  clientSecret: string; // Encrypted

  @Column({ name: 'instance_id', type: 'text', nullable: true })
  instanceId: string; // Encrypted - WMTS Configuration Instance ID

  @Field()
  @Column({ name: 'is_configured', default: false })
  isConfigured: boolean;

  @Field({ nullable: true })
  @Column({ name: 'last_used', type: 'timestamptz', nullable: true })
  lastUsed: Date;

  @Field(() => Int)
  @Column({ name: 'usage_count', default: 0 })
  usageCount: number;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * GraphQL Output Types
 */

@ObjectType()
export class SentinelHubStatus {
  @Field()
  isConfigured: boolean;

  @Field({ nullable: true })
  clientIdMasked?: string;

  @Field({ nullable: true })
  instanceIdMasked?: string;

  @Field({ nullable: true })
  lastUsed?: Date;

  @Field(() => Int)
  usageCount: number;
}

@ObjectType()
export class SentinelHubCredentials {
  @Field()
  clientId: string;

  @Field()
  clientSecret: string;
}

@ObjectType()
export class SentinelHubToken {
  @Field()
  accessToken: string;

  @Field(() => Int)
  expiresIn: number;
}

@ObjectType()
export class SentinelHubWmtsConfig {
  @Field()
  instanceId: string;

  @Field()
  accessToken: string;

  @Field(() => Int)
  expiresIn: number;
}
