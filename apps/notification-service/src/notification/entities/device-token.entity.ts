import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Unique,
} from 'typeorm';

/**
 * Device Token Entity
 * Stores FCM/push notification device tokens for users
 */
@Entity('device_tokens')
@Unique(['userId', 'token'])
export class DeviceToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'token', type: 'varchar' })
  token!: string;

  @Column({ name: 'platform', type: 'varchar' })
  platform!: string; // 'web' | 'android' | 'ios'

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt?: Date;
}
