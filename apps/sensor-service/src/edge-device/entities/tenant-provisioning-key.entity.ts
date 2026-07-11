import {
  ObjectType,
  Field,
  ID,
  Int,
} from '@nestjs/graphql';
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@ObjectType()
@Entity('tenant_provisioning_keys')
@Index(['keyToken'], { unique: true })
export class TenantProvisioningKey {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  /**
   * SENSOR-MEDIUM-001: stored at rest as the SHA-256 hex digest of the raw
   * key, never the plaintext. It carries NO `@Field()` on purpose — the digest
   * must never be selectable over GraphQL (it is useless to a client and its
   * exposure only invites confusion with the real secret). The plaintext key is
   * surfaced exactly once, at creation, via the `TenantKeyResponse` DTO.
   */
  @Column({ name: 'key_token', length: 64, unique: true })
  keyToken!: string;

  @Field({ nullable: true })
  @Column({ name: 'name', length: 200, nullable: true })
  name?: string;

  @Field()
  @Column({ name: 'is_active', default: true })
  isActive!: boolean;

  @Field(() => Int, { nullable: true })
  @Column({ name: 'max_devices', type: 'int', nullable: true })
  maxDevices?: number;

  @Field(() => Int)
  @Column({ name: 'used_count', type: 'int', default: 0 })
  usedCount!: number;

  @Field()
  @Column({ name: 'auto_approve', default: false })
  autoApprove!: boolean;

  @Field({ nullable: true })
  @Column({ name: 'default_site_id', type: 'uuid', nullable: true })
  defaultSiteId?: string;

  @Field({ nullable: true })
  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt?: Date;

  @Field({ nullable: true })
  @Column({ name: 'created_by', nullable: true })
  createdBy?: string;

  @Field()
  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
