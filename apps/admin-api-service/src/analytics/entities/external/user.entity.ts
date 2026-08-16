/**
 * User Entity (Read-only reference)
 *
 * This is a read-only view of the user table owned by auth-service.
 * Used for cross-service analytics queries in the shared database.
 * DO NOT modify - source of truth is auth-service.
 */

import { Role, type Role as RoleCode } from '@platform/identity';
import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Read from auth schema (shared database) - read-only reference
@Entity('users', { schema: 'auth', synchronize: false })
export class UserReadOnly {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName!: string | null;

  @Column({ type: 'varchar', length: 50, default: Role.MODULE_USER })
  role!: RoleCode;

  @Column({ type: 'uuid', nullable: true })
  tenantId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false })
  isEmailVerified!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
